#!/usr/bin/env bash
# Install the local tooling Lazyfox's dev/CI workflow needs, all under .tools/
# (gitignored). Idempotent. Works on Void Linux and any distro with curl+tar.
#
# What it installs:
#   - actionlint   : static validate .github/workflows/*.yml (used by `npm run ci`)
#   - act          : run the GitHub workflows locally in Docker (optional, needs a
#                    running docker daemon); see docs/CI.md
#   - geckodriver  : WebDriver binary for the BiDi end-to-end suite (v0.37.1,
#                    matching the pinned CI version)
#
# Usage:  bash scripts/install-tools.sh           (everything available)
#         bash scripts/install-tools.sh actionlint geckodriver   (subset)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GOARCH="amd64"; ACT_ARCH="x86_64" ;;
  aarch64|arm64) GOARCH="arm64"; ACT_ARCH="arm64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

want() { [ $# -eq 0 ] || [[ " $* " == *" $1 "* ]]; }

install_actionlint() {
  [ -x "$TOOLS/actionlint" ] && { echo "actionlint: already installed"; return; }
  local v; v="$(curl -fsSL https://api.github.com/repos/rhysd/actionlint/releases/latest | grep -m1 '"tag_name"' | grep -oE '[0-9.]+')"
  echo "→ installing actionlint v$v ($GOARCH)"
  curl -fsSL -o /tmp/actionlint.tar.gz \
    "https://github.com/rhysd/actionlint/releases/download/v$v/actionlint_${v}_linux_${GOARCH}.tar.gz"
  tar -xzf /tmp/actionlint.tar.gz -C "$TOOLS" actionlint
  chmod +x "$TOOLS/actionlint"
  rm -f /tmp/actionlint.tar.gz
  echo "✓ actionlint -> $TOOLS/actionlint"
}

install_act() {
  [ -x "$TOOLS/act" ] && { echo "act: already installed"; return; }
  local v; v="$(curl -fsSL https://api.github.com/repos/nektos/act/releases/latest | grep -m1 '"tag_name"' | grep -oE '[0-9.]+')"
  echo "→ installing act v$v ($ACT_ARCH)"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/act.tar.gz" \
    "https://github.com/nektos/act/releases/download/v$v/act_Linux_${ACT_ARCH}.tar.gz"
  tar -xzf "$tmp/act.tar.gz" -C "$tmp" act
  mv "$tmp/act" "$TOOLS/act"
  chmod +x "$TOOLS/act"
  rm -rf "$tmp"
  echo "✓ act -> $TOOLS/act  (run with: GITHUB_TOKEN=\$(gh auth token) ./.tools/act …)"
}

install_geckodriver() {
  [ -x "$TOOLS/geckodriver" ] && { echo "geckodriver: already installed"; return; }
  echo "→ installing geckodriver v0.37.1 ($GOARCH)"
  curl -fsSL -o /tmp/geckodriver.tar.gz \
    "https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux${GOARCH}.tar.gz"
  tar -xzf /tmp/geckodriver.tar.gz -C "$TOOLS" geckodriver
  chmod +x "$TOOLS/geckodriver"
  rm -f /tmp/geckodriver.tar.gz
  echo "✓ geckodriver -> $TOOLS/geckodriver"
}

if want actionlint actionlint install_act act geckodriver; then
  install_actionlint
  install_act
  install_geckodriver
else
  want actionlint && install_actionlint
  want act && install_act
  want geckodriver && install_geckodriver
  echo "done."
fi