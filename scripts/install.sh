#!/usr/bin/env bash
# Lazyfox one-click installer for Linux.
#
# - Finds your Firefox profile automatically (prefers a Developer Edition
#   profile), or installs into the one you pass on the command line.
# - Drops chrome/userChrome.css, chrome/userChrome.uc.js and chrome/frame.js
#   into the profile's chrome/ folder, and merges chrome/user.js into user.js
#   (only the prefs Lazyfox manages; your other prefs are kept). Run it again
#   any time — it only updates what it owns.
# - Builds and installs the WebExtension into the profile's extensions/ folder
#   and enables it (Firefox's sideload protection is bypassed via prefs +
#   a one-shot import launch when needed).
# - Installs the fx-autoconfig-style chrome loader into the Firefox install
#   directory (config.js + defaults/pref/config-prefs.js). This needs root
#   rights once, so this script auto-elevates with sudo when necessary.
#
# Your Firefox data, profiles and bookmarks are never touched or deleted —
# only Lazyfox's own files inside the chosen profile are written, and every
# file we replace is backed up as <name>.lazyfox.bak-<timestamp>.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROFILE="${1:-}"
NO_EXTENSION=0
NO_LAUNCH=0
CHROME_LOADER_ONLY=0
EXPLICIT_FFDIR=""

usage() {
  cat <<USAGE
Usage: $0 [profile] [options]

  profile            Profile path to install into (optional; auto-detected).
  -NoExtension       Skip the WebExtension build/install.
  -NoLaunch          Skip the automatic first-import launch of Firefox.
  -ChromeLoaderOnly  Only install the fx-autoconfig loader into -FirefoxDir
                     and exit (implies -NoLaunch).
  -FirefoxDir DIR    Firefox installation directory (overrides auto-detect).
  -h | -help         Show this help.

Env vars:
  NO_EXTENSION=1, NO_LAUNCH=1, FIREFOX_BIN=/path/to/firefox
  (FIREFOX_BIN is honored only when -FirefoxDir is not given.)
USAGE
}

# Parse args: a leading bare path is the profile (matches install.ps1 -Profile).
while [[ $# -gt 0 ]]; do
  case "$1" in
    -NoExtension)        NO_EXTENSION=1; shift ;;
    -NoLaunch)          NO_LAUNCH=1; shift ;;
    -ChromeLoaderOnly)  CHROME_LOADER_ONLY=1; shift ;;
    -FirefoxDir)        EXPLICIT_FFDIR="$2"; shift 2 ;;
    -h|-help|--help)   usage; exit 0 ;;
    -*)                echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$PROFILE" ]]; then
        PROFILE="$1"
      else
        echo "Unexpected argument: $1" >&2; usage >&2; exit 2
      fi
      shift
      ;;
  esac
done

[[ "${NO_EXTENSION:-0}" == "1" ]] && NO_EXTENSION=1
[[ "${NO_LAUNCH:-0}" == "1" ]] && NO_LAUNCH=1

step()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
notice(){ printf '\033[34mNOTE:\033[0m %s\n' "$*"; }

stamp() { date +%Y%m%d-%H%M%S; }

# Non-destructively back up a file/dir before we overwrite it, if it exists.
backup_if_exists() {
  local p="$1"
  if [[ -e "$p" && ! -L "$p" ]]; then
    mv "$p" "$p.lazyfox.bak-$(stamp)"
  fi
}

# ---------- Profile resolution ----------

MOZ="${MOZ_DIR:-$HOME/.mozilla/firefox}"

read_profiles_ini() {
  # Emit "<section>\t<Default>\t<Path>" lines from profiles.ini.
  local ini="$MOZ/profiles.ini"
  [[ -f "$ini" ]] || return 1
  awk -v RS='\r?\n' '
    /^\[/ { if (section!="") { print section "\t" def "\t" path; def="0"; path="" }; section=$0; next }
    /^Default=/ { def="1" }
    /^Path=/ { path=substr($0,6) }
    END { if (section!="") print section "\t" def "\t" path }
  ' "$ini"
}

resolve_default_profile() {
  local line sec def pth
  local dev_default="" any_default="" first_dev=""
  while IFS=$'\t' read -r sec def pth; do
    [[ -n "${pth:-}" ]] || continue
    [[ -n "$first_dev" ]] || first_dev="$pth"
    local rooted
    if [[ "${pth:0:1}" == "/" ]]; then rooted="$pth"; else rooted="$MOZ/$pth"; fi
    # Prefer a Developer Edition profile by name/section/path heuristics.
    if [[ "$sec" == *dev-edition* ]] || [[ "$pth" == *dev-edition* ]] || [[ "$pth" == *dev-edition-default* ]]; then
      dev_default="$rooted"
    fi
    if [[ "$def" == "1" && -z "$any_default" ]]; then any_default="$rooted"; fi
  done < <(read_profiles_ini)
  if [[ -n "$dev_default" ]]; then printf '%s' "$dev_default"; return 0; fi
  if [[ -n "$any_default" ]]; then printf '%s' "$any_default"; return 0; fi
  if [[ -n "$first_dev" ]]; then printf '%s' "$first_dev"; return 0; fi
  return 1
}

if [[ -z "$PROFILE" ]]; then
  PROFILE="$(resolve_default_profile || true)"
fi

if [[ -z "$PROFILE" || ! -d "$PROFILE" ]]; then
  cat <<ERR
Could not find a Firefox profile automatically.
Open Firefox -> about:support and copy the "Profile Folder" path, then run:
  $0 "/path/to/profile"
ERR
  exit 1
fi

step "Profile: $PROFILE"

# ---------- stop this profile's Firefox (one-click install) ----------

ff_running_for_profile() {
  [[ -f "$PROFILE/.parentlock" || -f "$PROFILE/parent.lock" || -f "$PROFILE/lock" ]] || \
    pgrep -u "$(id -un)" -f "$PROFILE" >/dev/null 2>&1
}
if ff_running_for_profile; then
  notice "Firefox is running with this profile; stopping it so the add-on can be enabled..."
  pkill -u "$(id -un)" -f "$PROFILE" 2>/dev/null || true
  sleep 2
fi

# ---------- Firefox binary / install dir ----------

find_firefox_bin() {
  if [[ -n "${FIREFOX_BIN:-}" && -x "$FIREFOX_BIN" ]]; then printf '%s' "$FIREFOX_BIN"; return 0; fi
  local cands=(
    "/usr/bin/firefox-developer-edition"
    "/usr/bin/firefox-aurora"
    "/usr/bin/firefox"
    "/usr/lib/firefox-developer-edition/firefox"
    "/usr/lib/firefox/firefox"
    "/opt/firefox/firefox"
    "/snap/bin/firefox"
  )
  local c
  for c in "${cands[@]}"; do
    if [[ -x "$c" ]]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

# Walk symlinks to get the real install directory of the firefox binary.
# Works for /usr/bin/firefox (Debian/Fedora) and /opt/firefox/firefox.
resolve_ff_dir() {
  local bin; bin="$(find_firefox_bin || true)"
  [[ -n "$bin" ]] || return 1
  local real; real="$(readlink -f "$bin")"
  [[ -n "$real" ]] || real="$bin"
  dirname "$real"
}

# ---------- Chrome loader (fx-autoconfig) ----------

install_chrome_loader_into() {
  local ffdir="$1"
  [[ -n "$ffdir" && -d "$ffdir" ]] || { warn "Firefox install dir not found: '$ffdir'"; return 2; }
  local prefdir="$ffdir/defaults/pref"
  mkdir -p "$prefdir"
  backup_if_exists "$ffdir/config.js"
  backup_if_exists "$prefdir/config-prefs.js"
  cp -f "$REPO_ROOT/dist/chrome/loader/config.js" "$ffdir/config.js"
  cp -f "$REPO_ROOT/dist/chrome/loader/config-prefs.js" "$prefdir/config-prefs.js"
  return 0
}

if [[ "$CHROME_LOADER_ONLY" -eq 1 ]]; then
  ffdir="$EXPLICIT_FFDIR"
  if [[ -z "$ffdir" ]]; then ffdir="$(resolve_ff_dir || true)"; fi
  if install_chrome_loader_into "$ffdir"; then
    step "Chrome loader installed into $ffdir"
    exit 0
  fi
  warn "Could not install the chrome loader."
  exit 1
fi

# ---------- Chrome assets (profile-side, no root needed) ----------

mkdir -p "$PROFILE/chrome"
cp -f "$REPO_ROOT/dist/chrome/userChrome.css"   "$PROFILE/chrome/userChrome.css"
cp -f "$REPO_ROOT/dist/chrome/userChrome.uc.js" "$PROFILE/chrome/userChrome.uc.js"
cp -f "$REPO_ROOT/dist/chrome/frame.js"         "$PROFILE/chrome/frame.js"
cp -f "$REPO_ROOT/dist/chrome/corebootstrap.js" "$PROFILE/chrome/corebootstrap.js"
step "Installed chrome/userChrome.css, userChrome.uc.js, frame.js and corebootstrap.js"

# Clean up stale Lazyfox backups (older than 30 days) from previous installs so
# an old install can't pile up cruft. Fresh backups are the rollback safety net.
remove_stale_backups() {
  local dir="$1"
  [[ -d "$dir" ]] || return
  find "$dir" -maxdepth 1 \( -name '*.lazyfox.bak-*' -o -name '*.lazyfox.uninst.bak-*' \) \
    2>/dev/null | while read -r f; do
    if [[ -n "$f" ]] && [[ "$(find "$f" -mtime +30 2>/dev/null)" != "" ]]; then
      rm -f "$f" && notice "removed stale backup: $(basename "$f")"
    fi
  done
}
remove_stale_backups "$PROFILE/chrome"
remove_stale_backups "$PROFILE/extensions"

# ---------- user.js merge (Lazyfox prefs only) ----------

managed_regex=""
while IFS= read -r line; do
  name="$(printf '%s' "$line" | sed -n 's/^user_pref("\([^"]*\)".*/\1/p')"
  if [[ -n "$name" ]]; then
    managed_regex+="user_pref\\(\"$name\"|"
  fi
done < "$REPO_ROOT/dist/chrome/user.js"
managed_regex="(${managed_regex%|})"

user_js="$PROFILE/user.js"
backup_if_exists "$user_js"
prev=""
if [[ -f "$user_js" ]]; then
  prev="$(grep -vE "$managed_regex" "$user_js" || true)"
fi
{ printf '%s\n' "$prev"; cat "$REPO_ROOT/dist/chrome/user.js"; } > "$user_js.tmp"
mv "$user_js.tmp" "$user_js"
step "Merged preferences into user.js (existing prefs preserved)"

# ---------- fx-autoconfig loader (install dir, root) ----------

# The chrome loader lives in the Firefox installation folder (read-only for the
# user), so installing it requires root once. Auto-elevate if we can.
ffdir="$EXPLICIT_FFDIR"
if [[ -z "$ffdir" ]]; then ffdir="$(resolve_ff_dir || true)"; fi
if [[ -n "$ffdir" && -d "$ffdir" ]]; then
  # Re-install when the files are missing OR when their content drifted from
  # the bundled loader (a Firefox update or an older Lazyfox can leave a
  # loader that no longer matches, e.g. Firefox 155 stopped trusting file:
  # URLs in loadSubScript). Existence alone is not enough for upgrades.
  if [[ -f "$ffdir/config.js" && -f "$ffdir/defaults/pref/config-prefs.js" ]] &&
     cmp -s "$REPO_ROOT/dist/chrome/loader/config.js" "$ffdir/config.js" &&
     cmp -s "$REPO_ROOT/dist/chrome/loader/config-prefs.js" "$ffdir/defaults/pref/config-prefs.js"; then
    step "Chrome loader already installed in $ffdir"
  else
    if [[ "$(id -u)" -eq 0 ]]; then
      install_chrome_loader_into "$ffdir" && step "Chrome loader installed into $ffdir"
    elif command -v sudo >/dev/null 2>&1; then
      step "Installing the chrome loader into $ffdir requires root (one-time). sudo may prompt."
      if sudo -n true 2>/dev/null; then
        if sudo bash -c "
            set -eu
            cp -f '$REPO_ROOT/dist/chrome/loader/config.js' '$ffdir/config.js'
            mkdir -p '$ffdir/defaults/pref'
            cp -f '$REPO_ROOT/dist/chrome/loader/config-prefs.js' '$ffdir/defaults/pref/config-prefs.js'
          "; then
          step "Chrome loader installed into $ffdir (sudo)"
        else
          warn "sudo install failed. The command center's about: pages and Ctrl+Alt+O/A/H/D hotkeys will not work."
          warn "Run:  sudo bash -c 'cp -f \"$REPO_ROOT/dist/chrome/loader/config.js\" \"$ffdir/config.js\" && mkdir -p \"$ffdir/defaults/pref\" && cp -f \"$REPO_ROOT/dist/chrome/loader/config-prefs.js\" \"$ffdir/defaults/pref/config-prefs.js\"'"
        fi
      else
        warn "sudo requires a password. The chrome loader must be installed once with:"
        warn "  sudo bash -c 'cp -f \"$REPO_ROOT/dist/chrome/loader/config.js\" \"$ffdir/config.js\" && mkdir -p \"$ffdir/defaults/pref\" && cp -f \"$REPO_ROOT/dist/chrome/loader/config-prefs.js\" \"$ffdir/defaults/pref/config-prefs.js\"'"
        warn "Continuing without the chrome loader; press ; on internal pages or use Ctrl+Alt+Space."
      fi
    else
      warn "sudo not found. Install the chrome loader manually (one-time):"
      warn "  cp -f \"$REPO_ROOT/dist/chrome/loader/config.js\" \"$ffdir/config.js\""
      warn "  mkdir -p \"$ffdir/defaults/pref\""
      warn "  cp -f \"$REPO_ROOT/dist/chrome/loader/config-prefs.js\" \"$ffdir/defaults/pref/config-prefs.js\""
    fi
  fi
else
  warn "Could not locate the Firefox installation directory; chrome loader not installed."
  warn "Set FIREFOX_BIN or pass -FirefoxDir /path/to/firefox-dir to install it."
fi

# ---------- Optional: Web extension build + enable ----------

if [[ "$NO_EXTENSION" -eq 0 ]]; then
  extensions_dir="$PROFILE/extensions"
  mkdir -p "$extensions_dir"
  xpi="$extensions_dir/lazyfox@lazyfox.dev.xpi"

  # Build the .xpi (zip). Prefer zip, fall back to python3, then node, then
  # tar+gzip-renamed which isn't valid — bail out instead.
  backup_if_exists "$xpi"
  ext_dir="$REPO_ROOT/dist/extension"
  if command -v zip >/dev/null 2>&1; then
    ( cd "$ext_dir" && zip -rq "$xpi" . -x '*.DS_Store' )
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$ext_dir" "$xpi" <<'PY'
import shutil, sys, os
src, dst = sys.argv[1], sys.argv[2]
shutil.make_archive(dst[:-4], 'zip', src)
os.replace(dst[:-4] + '.zip', dst)
PY
  elif command -v node >/dev/null 2>&1; then
    node - "$ext_dir" "$xpi" <<'JS'
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const [src, dst] = process.argv.slice(2);
let zip;
try { zip = require('adm-zip'); } catch {}
if (zip) {
  const z = new zip();
  z.addLocalFolder(src);
  z.writeZip(dst);
} else {
  // Last-ditch: use `zip` via npm not assumed. Emit a clean error.
  console.error("node: install adm-zip, or provide python3 / zip on PATH.");
  process.exit(1);
}
JS
  else
    warn "Neither 'zip' nor 'python3' nor 'node' available; skipping extension build."
    warn "Build it manually and drop it at: $xpi"
  fi
  [[ -f "$xpi" ]] && step "Built and installed extension: $xpi"

  # Drop the add-on startup cache AND the cached Lazyfox entry so the add-on
  # is re-imported fresh from the freshly built xpi on the next launch.
  #
  # WHY: Firefox caches an add-on's metadata (including which content scripts
  # to inject) in extensions.json + addonStartup.json.lz4 and trusts it at
  # startup. If a newer xpi is installed with the same id+version, that cached
  # metadata is never refreshed, so content scripts silently stop injecting
  # (the extension still loads: the command center works, but ; / ;f / ;i /
  # Esc on web pages do nothing). Dropping both forces a clean re-import.
  # Other add-ons are untouched, and the re-imported Lazyfox is enabled by
  # default (extensions.autoDisableScopes=0 in our user.js).
  addon_startup="$PROFILE/addonStartup.json.lz4"
  if [[ -f "$addon_startup" ]]; then
    rm -f "$addon_startup"
    step "Cleared the add-on startup cache (addonStartup.json.lz4)."
  fi
  ext_json="$PROFILE/extensions.json"
  ext_json_edit() {
    local jp="$1"
    if command -v python3 >/dev/null 2>&1; then
      backup_if_exists "$jp"
      python3 - "$jp" <<'PY'
import json, sys
p = sys.argv[1]
with open(p, encoding="utf-8") as f:
    data = json.load(f)
before = len(data.get("addons", []))
data["addons"] = [a for a in data.get("addons", []) if a.get("id") != "lazyfox@lazyfox.dev"]
with open(p, "w", encoding="utf-8") as f:
    json.dump(data, f)
sys.exit(0 if before != len(data["addons"]) else 1)
PY
      return $?
    elif command -v node >/dev/null 2>&1; then
      backup_if_exists "$jp"
      node - "$jp" <<'JS'
const fs = require("fs");
const p = process.argv[2];
const data = JSON.parse(fs.readFileSync(p, "utf8"));
const before = (data.addons || []).length;
data.addons = (data.addons || []).filter(x => x.id !== "lazyfox@lazyfox.dev");
fs.writeFileSync(p, JSON.stringify(data, null, 2));
process.exit(before === data.addons.length ? 1 : 0);
JS
      return $?
    fi
    return 2
  }

  # profile_lockfile_for_running_firefox: SQLite-style lock files exist in the
  # profile when Firefox is running. We only edit extensions.json when the
  # profile is NOT in use, otherwise the changes would be overwritten.
  ff_running_for_profile() {
    [[ -f "$PROFILE/.parentlock" || -f "$PROFILE/parent.lock" || -f "$PROFILE/lock" ]] || pgrep -u "$(id -un)" -f "$PROFILE" >/dev/null 2>&1
  }

  if [[ -f "$ext_json" ]]; then
    if ff_running_for_profile; then
      notice "Firefox is running with this profile. Quit it, then re-run this installer to auto-enable Lazyfox."
    else
      if ext_json_edit "$ext_json"; then
        step "Refreshed Lazyfox in extensions.json (re-imported on next launch with fresh metadata)."
      else
        warn "Lazyfox not yet listed in extensions.json. It will be imported on the next Firefox launch."
      fi
    fi
  elif [[ "$NO_LAUNCH" -eq 0 ]]; then
    ff_bin="$(find_firefox_bin || true)"
    if [[ -n "$ff_bin" ]]; then
      step "First install: launching Firefox once to import Lazyfox..."
      "$ff_bin" -profile "$PROFILE" about:blank >/dev/null 2>&1 &
      fpid=$!
      imported=0
      for _ in $(seq 1 20); do
        sleep 3
        if [[ -f "$ext_json" ]] && grep -q 'lazyfox@lazyfox.dev' "$ext_json" 2>/dev/null; then
          imported=1; break
        fi
      done
      # Stop only the Firefox process we launched for THIS profile import,
      # never anything else.
      kill "$fpid" 2>/dev/null || true
      pkill -P "$fpid" 2>/dev/null || true
      sleep 2
      if [[ $imported -eq 1 ]]; then
        if ext_json_edit "$ext_json"; then
          step "Lazyfox imported and enabled. It stays enabled on future launches."
        else
          warn "Imported but could not auto-enable. Enable Lazyfox once in about:addons."
        fi
      else
        warn "Firefox did not finish importing the add-on. Enable Lazyfox once in about:addons after your next launch."
      fi
    else
      warn "Could not locate firefox to trigger the first import. Enable Lazyfox once in about:addons."
    fi
  fi
fi

echo
echo "Done. Lazyfox is installed and enabled."
echo
echo "Things to check:"
echo "  1. All chrome UI (tabs, URL bar, menus) is removed. Move the mouse to the very top edge of the window to reveal the URL bar on demand; ;z toggles fullscreen/zen mode."
echo "  2. Press ; (semicolon) on any page for the which-key overlay: ;o URL, ;s search, ;t tabs, ;n new tab, ;w resize..."
echo "  3. If Lazyfox is not listed in about:addons, load it manually:"
echo "       about:debugging -> This Firefox -> Load Temporary Add-on -> dist/extension/manifest.json"
echo "  4. The unsigned add-on only persists on Firefox Developer Edition / Nightly"
echo "     (xpinstall.signatures.required=false is already set for you)."
echo "  5. Re-run this installer any time you update Lazyfox; it only writes its own"
echo "     files and never touches your profile data."

if [[ "$NO_LAUNCH" -eq 0 ]]; then
  ff_bin="$(find_firefox_bin || true)"
  if [[ -n "$ff_bin" ]]; then
    step "Launching Firefox with the profile..."
    "$ff_bin" -profile "$PROFILE" >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
fi
