#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOZ="${MOZ_DIR:-$HOME/.mozilla/firefox}"
PROFILE="${1:-}"

step() { printf '==> %s\n' "$*"; }

resolve_default_profile() {
  local ini="$MOZ/profiles.ini"
  [ -f "$ini" ] || return 1
  local cur_def=0 cur_path="" out="" line
  while IFS= read -r line; do
    if [[ "$line" == \[*\] ]]; then
      if [[ $cur_def -eq 1 && -n "$cur_path" ]]; then out="$cur_path"; break; fi
      cur_def=0; cur_path=""
      continue
    fi
    if [[ "$line" == Default=1 ]]; then cur_def=1; fi
    if [[ "$line" == Path=* ]]; then cur_path="${line#Path=}"; fi
  done < "$ini"
  if [[ $cur_def -eq 1 && -n "$cur_path" && -z "$out" ]]; then out="$cur_path"; fi
  if [[ -n "$out" && "${out:0:1}" != "/" ]]; then out="$MOZ/$out"; fi
  printf '%s' "$out"
}

if [[ -n "$PROFILE" ]]; then
  profile_dir="$PROFILE"
else
  profile_dir="$(resolve_default_profile || true)"
fi

if [[ -z "$profile_dir" || ! -d "$profile_dir" ]]; then
  echo "Could not find a Firefox profile automatically."
  echo "Open Firefox, go to about:support and copy the 'Profile Folder' path, then run:"
  echo "  ./scripts/install.sh \"/path/to/profile\""
  exit 1
fi

step "Profile: $profile_dir"

mkdir -p "$profile_dir/chrome"
cp -f "$REPO_ROOT/chrome/userChrome.css" "$profile_dir/chrome/userChrome.css"
step "Installed chrome/userChrome.css"

managed_regex=""
while IFS= read -r line; do
  name="$(printf '%s' "$line" | sed -n 's/^user_pref("\([^"]*\)".*/\1/p')"
  if [[ -n "$name" ]]; then
    managed_regex+="user_pref\(\"$name\"|"
  fi
done < "$REPO_ROOT/chrome/user.js"
managed_regex="${managed_regex%|}"

user_js="$profile_dir/user.js"
filtered=""
if [[ -f "$user_js" ]]; then
  filtered="$(grep -vE "$managed_regex" "$user_js" || true)"
fi
{
  printf '%s\n' "$filtered"
  cat "$REPO_ROOT/chrome/user.js"
} > "$user_js.tmp"
mv "$user_js.tmp" "$user_js"
step "Merged preferences into user.js"

if [[ "${NO_EXTENSION:-0}" != "1" ]]; then
  extensions_dir="$profile_dir/extensions"
  mkdir -p "$extensions_dir"
  xpi="$extensions_dir/lazyfox@lazyfox.dev.xpi"
  rm -f "$xpi"
  if command -v zip >/dev/null 2>&1; then
    ( cd "$REPO_ROOT/extension" && zip -rq "$xpi" . -x '*.DS_Store' )
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import shutil, sys
shutil.make_archive('$extensions_dir/lazyfox', 'zip', '$REPO_ROOT/extension')
import os
os.rename('$extensions_dir/lazyfox.zip', '$xpi')
"
  else
    echo "WARNING: neither 'zip' nor 'python3' found; skipping extension build."
    echo "Build it manually and drop it at: $xpi"
  fi
  step "Built and installed extension: $xpi"

  ext_json="$profile_dir/extensions.json"
  json_edit() {
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$ext_json" <<'PY'
import json, sys
p = sys.argv[1]
with open(p, encoding="utf-8") as f:
    data = json.load(f)
for a in data.get("addons", []):
    if a.get("id") == "lazyfox@lazyfox.dev":
        a["userDisabled"] = False
        a["active"] = True
        a["visible"] = True
        break
else:
    sys.exit(1)
with open(p, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
      return $?
    elif command -v node >/dev/null 2>&1; then
      node - "$ext_json" <<'JS'
const fs = require("fs");
const p = process.argv[2];
const data = JSON.parse(fs.readFileSync(p, "utf8"));
const a = (data.addons || []).find(x => x.id === "lazyfox@lazyfox.dev");
if (!a) process.exit(1);
a.userDisabled = false; a.active = true; a.visible = true;
fs.writeFileSync(p, JSON.stringify(data));
JS
      return $?
    fi
    return 2
  }

  if [[ -f "$ext_json" ]]; then
    if [[ -f "$profile_dir/lock" ]]; then
      echo "NOTE: this profile is currently in use by Firefox. Quit it, then re-run this installer to auto-enable Lazyfox."
    elif json_edit; then
      step "Enabled Lazyfox (it was installed but disabled by Firefox's sideload protection)."
    elif [[ $? -eq 2 ]]; then
      echo "WARNING: no python3/node to edit extensions.json. Enable Lazyfox once in about:addons."
    fi
  elif [[ "${NO_LAUNCH:-0}" != "1" ]]; then
    ff="${FIREFOX_BIN:-}"
    if [[ -z "$ff" ]]; then ff="$(command -v firefox 2>/dev/null || true)"; fi
    if [[ -n "$ff" ]]; then
      step "First install: launching Firefox once to import Lazyfox..."
      "$ff" -profile "$profile_dir" about:blank >/dev/null 2>&1 &
      fpid=$!
      imported=0
      for _ in $(seq 1 20); do
        sleep 3
        if grep -q 'lazyfox@lazyfox.dev' "$ext_json" 2>/dev/null; then imported=1; break; fi
      done
      kill "$fpid" 2>/dev/null || true
      pkill -P "$fpid" 2>/dev/null || true
      sleep 2
      if [[ $imported -eq 1 ]]; then
        if json_edit; then
          step "Lazyfox imported and enabled. It stays enabled on future launches."
        elif [[ $? -eq 2 ]]; then
          echo "WARNING: no python3/node to edit extensions.json. Enable Lazyfox once in about:addons."
        fi
      else
        echo "WARNING: Firefox did not finish importing the add-on. Enable Lazyfox once in about:addons after your next launch."
      fi
    else
      echo "WARNING: could not locate firefox to trigger the first import. Enable Lazyfox once in about:addons."
    fi
  fi
fi

echo
echo "Done. Fully quit and restart Firefox."
echo
echo "Things to check:"
echo "  1. All chrome UI (tabs, URL bar, menus) should be hidden. Move the mouse to the very top edge to reveal them; ;z toggles fullscreen/zen mode."
echo "  2. If Lazyfox is not listed in about:addons, load it manually:"
echo "       about:debugging -> This Firefox -> Load Temporary Add-on -> extension/manifest.json"
echo "  3. The unsigned add-on only persists on Firefox Developer Edition / Nightly."
