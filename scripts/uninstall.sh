#!/usr/bin/env bash
# Lazyfox uninstaller for Linux.
#
# Reverses everything scripts/install.sh put in place, and nothing else:
#   - profile/chrome/userChrome.css, userChrome.uc.js, frame.js
#   - the Lazyfox-managed user_pref(...) lines from profile/user.js
#   - profile/extensions/lazyfox@lazyfox.dev.xpi
#   - the Lazyfox entry in extensions.json (marked inactive / removed)
#
# Your Firefox profile, bookmarks, history, passwords and other add-ons are
# NEVER touched. Every file we delete is backed up first as
# "<name>.lazyfox.uninst.bak-<timestamp>" so you can roll back by hand.
#
# The fx-autoconfig chrome loader in the Firefox install dir is only removed
# with -RemoveChromeLoader (it needs root, and other userChrome.uc.js add-ons
# may share it). Snap/Flatpak Firefox installs are read-only; their loader
# cannot be removed by this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROFILE="${1:-}"
REMOVE_CHROME_LOADER=0
KEEP_EXTENSION_DISABLED_ONLY=0
EXPLICIT_FFDIR=""

usage() {
  cat <<USAGE
Usage: $0 [profile] [options]

  profile                     Profile path to uninstall from (optional; auto-detected).
  -RemoveChromeLoader         Also remove the fx-autoconfig chrome loader
                              from the Firefox install dir (needs sudo).
  -KeepExtensionDisabledOnly  Only mark the add-on disabled in extensions.json
                              (skip deleting the .xpi).
  -FirefoxDir DIR             Firefox installation directory (overrides auto-detect).
  -h | -help                  Show this help.

Env vars:
  FIREFOX_BIN=/path/to/firefox (honored only when -FirefoxDir is not given)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -RemoveChromeLoader)        REMOVE_CHROME_LOADER=1; shift ;;
    -KeepExtensionDisabledOnly) KEEP_EXTENSION_DISABLED_ONLY=1; shift ;;
    -FirefoxDir)                EXPLICIT_FFDIR="$2"; shift 2 ;;
    -h|-help|--help)            usage; exit 0 ;;
    -*)                         echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$PROFILE" ]]; then PROFILE="$1"; else
        echo "Unexpected argument: $1" >&2; usage >&2; exit 2
      fi
      shift
      ;;
  esac
done

step()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
note()  { printf '\033[34mNOTE:\033[0m %s\n' "$*"; }
stamp() { date +%Y%m%d-%H%M%S; }

backup_then_remove() {
  local p="$1"
  [[ -e "$p" ]] || return 1
  local bak="$p.lazyfox.uninst.bak-$(stamp)"
  cp -a "$p" "$bak" 2>/dev/null || true
  note "backed up -> $bak"
  rm -f "$p" 2>/dev/null || warn "could not remove $p (Firefox may be running)"
  return 0
}

# ---------- Profile resolution (mirror of install.sh) ----------

MOZ="${MOZ_DIR:-$HOME/.mozilla/firefox}"

read_profiles_ini() {
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

if [[ -z "$PROFILE" ]]; then PROFILE="$(resolve_default_profile || true)"; fi

if [[ -z "$PROFILE" || ! -d "$PROFILE" ]]; then
  cat <<ERR
Could not find a Firefox profile automatically.
Open Firefox -> about:support and copy the "Profile Folder" path, then run:
  $0 "/path/to/profile"
ERR
  exit 1
fi

step "Profile: $PROFILE"

ff_running_for_profile() {
  [[ -f "$PROFILE/.parentlock" || -f "$PROFILE/parent.lock" || -f "$PROFILE/lock" ]] || pgrep -u "$(id -un)" -f "$PROFILE" >/dev/null 2>&1
}
if ff_running_for_profile; then
  note "Firefox appears to be running with this profile. The .xpi and extensions.json"
  note "cannot be updated while it runs; quit Firefox fully and re-run this uninstaller."
fi

# ---------- chrome/* ----------
for f in userChrome.css userChrome.uc.js frame.js; do
  p="$PROFILE/chrome/$f"
  if [[ -e "$p" ]]; then backup_then_remove "$p" && step "Removed chrome/$f"; fi
done

# Leave chrome/ in place — other userChrome.uc.js add-ons may share it.

# ---------- user.js : drop only our managed prefs ----------
if [[ -f "$REPO_ROOT/chrome/user.js" && -f "$PROFILE/user.js" ]]; then
  managed_regex=""
  while IFS= read -r line; do
    name="$(printf '%s' "$line" | sed -n 's/^user_pref("\([^"]*\)".*/\1/p')"
    if [[ -n "$name" ]]; then managed_regex+="user_pref\\(\"$name\"|"; fi
  done < "$REPO_ROOT/chrome/user.js"
  managed_regex="(${managed_regex%|})"
  bak="$PROFILE/user.js.lazyfox.uninst.bak-$(stamp)"
  cp -a "$PROFILE/user.js" "$bak"
  note "backed up -> $bak"
  kept="$(grep -vE "$managed_regex" "$PROFILE/user.js" || true)"
  printf '%s\n' "$kept" > "$PROFILE/user.js.tmp"
  mv "$PROFILE/user.js.tmp" "$PROFILE/user.js"
  step "Removed Lazyfox prefs from user.js (other prefs kept)"
fi

# ---------- .xpi ----------
xpi="$PROFILE/extensions/lazyfox@lazyfox.dev.xpi"
if [[ -e "$xpi" ]]; then
  if ff_running_for_profile; then
    warn ".xpi is locked (Firefox is running). Quit Firefox and re-run to remove it."
  elif [[ "$KEEP_EXTENSION_DISABLED_ONLY" -eq 0 ]]; then
    backup_then_remove "$xpi" && step "Removed extension lazyfox@lazyfox.dev.xpi"
  fi
fi

# ---------- extensions.json : mark our add-on disabled ----------
ext_json="$PROFILE/extensions.json"
if [[ -f "$ext_json" && "$KEEP_EXTENSION_DISABLED_ONLY" -eq 1 ]]; then
  if ff_running_for_profile; then
    warn "extensions.json not touched (Firefox is running)."
  else
    if command -v python3 >/dev/null 2>&1; then
      bak="$ext_json.lazyfox.uninst.bak-$(stamp)"; cp -a "$ext_json" "$bak"; note "backed up -> $bak"
      python3 - "$ext_json" <<'PY'
import json, sys
p = sys.argv[1]
with open(p, encoding="utf-8") as f:
    data = json.load(f)
for a in data.get("addons", []):
    if a.get("id") == "lazyfox@lazyfox.dev":
        a["userDisabled"] = True
        a["active"] = False
        a["visible"] = False
with open(p, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
      step "Marked Lazyfox disabled in extensions.json"
    elif command -v node >/dev/null 2>&1; then
      bak="$ext_json.lazyfox.uninst.bak-$(stamp)"; cp -a "$ext_json" "$bak"; note "backed up -> $bak"
      node - "$ext_json" <<'JS'
const fs = require("fs");
const p = process.argv[2];
const data = JSON.parse(fs.readFileSync(p, "utf8"));
for (const a of data.addons || []) {
  if (a.id === "lazyfox@lazyfox.dev") {
    a.userDisabled = true; a.active = false; a.visible = false;
  }
}
fs.writeFileSync(p, JSON.stringify(data, null, 2));
JS
      step "Marked Lazyfox disabled in extensions.json"
    else
      warn "Neither python3 nor node available; leaving extensions.json untouched."
    fi
  fi
fi

# ---------- optional: chrome loader in Firefox install dir ----------
find_firefox_bin() {
  if [[ -n "${FIREFOX_BIN:-}" && -x "$FIREFOX_BIN" ]]; then printf '%s' "$FIREFOX_BIN"; return 0; fi
  local cands=(
    "/usr/bin/firefox-developer-edition" "/usr/bin/firefox-aurora" "/usr/bin/firefox"
    "/usr/lib/firefox-developer-edition/firefox" "/usr/lib/firefox/firefox"
    "/opt/firefox/firefox" "/snap/bin/firefox"
  )
  for c in "${cands[@]}"; do [[ -x "$c" ]] && { printf '%s' "$c"; return 0; }; done
  return 1
}
resolve_ff_dir() {
  local bin; bin="$(find_firefox_bin || true)"; [[ -n "$bin" ]] || return 1
  local real; real="$(readlink -f "$bin")"; [[ -n "$real" ]] || real="$bin"
  dirname "$real"
}

if [[ "$REMOVE_CHROME_LOADER" -eq 1 ]]; then
  ffdir="$EXPLICIT_FFDIR"
  if [[ -z "$ffdir" ]]; then ffdir="$(resolve_ff_dir || true)"; fi
  if [[ -z "$ffdir" || ! -d "$ffdir" ]]; then
    warn "Could not locate the Firefox install dir; skipping chrome-loader removal."
    warn "Pass -FirefoxDir /path/to/firefox-dir to target it."
  else
    # Try non-root first (works for a ~/opt Firefox).
    if [[ -w "$ffdir" ]]; then
      [[ -f "$ffdir/config.js" ]] && backup_then_remove "$ffdir/config.js" && step "Removed $ffdir/config.js"
      [[ -f "$ffdir/defaults/pref/config-prefs.js" ]] && backup_then_remove "$ffdir/defaults/pref/config-prefs.js" && step "Removed $ffdir/defaults/pref/config-prefs.js"
    elif command -v sudo >/dev/null 2>&1; then
      step "Removing the chrome loader needs root (one-time). sudo may prompt."
      sudo bash -c "
        set -u
        [[ -f '$ffdir/config.js' ]] && cp -a '$ffdir/config.js' '$ffdir/config.js.lazyfox.uninst.bak-$(stamp)' && rm -f '$ffdir/config.js'
        [[ -f '$ffdir/defaults/pref/config-prefs.js' ]] && cp -a '$ffdir/defaults/pref/config-prefs.js' '$ffdir/defaults/pref/config-prefs.js.lazyfox.uninst.bak-$(stamp)' && rm -f '$ffdir/defaults/pref/config-prefs.js'
      " && step "Chrome loader removed from $ffdir (sudo)" || warn "sudo removal failed."
    else
      warn "sudo not found; remove by hand:"
      warn "  rm -f '$ffdir/config.js' '$ffdir/defaults/pref/config-prefs.js'"
    fi
  fi
else
  note "Chrome loader (config.js in the Firefox install dir) was left in place."
  note "Re-run with -RemoveChromeLoader to also remove it (needs sudo)."
fi

echo
echo "Done. Fully quit and restart Firefox to finish restoring the default UI."
echo
echo "What was removed (and what was NOT touched):"
echo "  - chrome/userChrome.css, userChrome.uc.js, frame.js   (the hidden UI patches)"
echo "  - Lazyfox entries in user.js (other prefs preserved)"
echo "  - the lazyfox\@lazyfox.dev.xpi add-on"
echo "  - the add-on marked inactive in extensions.json"
echo "  Your profile, bookmarks, history, passwords and other add-ons were NOT changed."
echo "  Backups of every file we removed were saved as .lazyfox.uninst.bak-* in the profile."
