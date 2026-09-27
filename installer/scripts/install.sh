#!/bin/sh
# Lazyfox one-line installer (macOS / Linux).
#
#   curl -fsSL https://github.com/YELrhilassi/lazyfox/releases/latest/download/install.sh | sh
#
# It downloads the installer for this machine and runs it. Everything after that
# is the installer's own UI — this script only fetches and launches it, so there
# is no shell logic that can half-install something.
#
# Options (env vars, because the script may be piped):
#   LAZYFOX_CHANNEL=nightly   use the rolling nightly build (Developer Edition / Nightly)
#   LAZYFOX_REPO=owner/name   use a fork's releases
#   LAZYFOX_DIR=/some/dir     download here instead of a temp dir (keeps the binary)
#   LAZYFOX_NO_RUN=1          download only, print the path, do not run
#
# Piping hides this script's own stdin?  No: because we are piped, stdin is the
# script itself, so before running the installer we re-attach the terminal
# (below) — otherwise the installer would read EOF instead of your keypresses.

set -eu

REPO="${LAZYFOX_REPO:-YELrhilassi/lazyfox}"
CHANNEL="${LAZYFOX_CHANNEL:-stable}"

say() { printf '%s\n' "$*"; }
die() { printf 'lazyfox-install: %s\n' "$*" >&2; exit 1; }

# --- what are we running on? -------------------------------------------------
os="$(uname -s 2>/dev/null || echo unknown)"
arch="$(uname -m 2>/dev/null || echo unknown)"

case "$os" in
  Linux) machine="linux" ;;
  Darwin) machine="darwin" ;;
  *) die "unsupported operating system: $os (this installer supports Linux and macOS)" ;;
esac

case "$arch" in
  x86_64|amd64) cpu="amd64" ;;
  arm64|aarch64) cpu="arm64" ;;
  *) die "unsupported CPU: $arch" ;;
esac

# The shipped binaries: linux/amd64 and darwin/arm64.
if [ "$machine" = "linux" ] && [ "$cpu" != "amd64" ]; then
  die "no prebuilt installer for linux/$cpu yet (linux/amd64 and darwin/arm64 are shipped)"
fi
if [ "$machine" = "darwin" ] && [ "$cpu" != "arm64" ]; then
  die "no prebuilt installer for darwin/$cpu yet (linux/amd64 and darwin/arm64 are shipped)"
fi

if [ "$CHANNEL" = "nightly" ]; then
  asset="lazyfox-install-dev-$machine"
  url="https://github.com/$REPO/releases/download/nightly/$asset"
else
  asset="lazyfox-install-$machine"
  url="https://github.com/$REPO/releases/latest/download/$asset"
fi

dir="${LAZYFOX_DIR:-$(mktemp -d 2>/dev/null || echo /tmp)}"
target="$dir/$asset"

say "Lazyfox installer"
say "  channel : $CHANNEL"
say "  machine : $machine/$cpu"
say "  from    : $url"

# --- fetch -------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  curl -fL --proto '=https' --tlsv1.2 -o "$target" "$url" || die "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$target" "$url" || die "download failed"
else
  die "neither curl nor wget is available"
fi

[ -s "$target" ] || die "downloaded file is empty"
chmod +x "$target" || die "could not make the installer executable"

# Show a checksum so a cautious user (or an admin) can compare it against the
# release notes. Nothing here trusts the network beyond HTTPS.
if command -v shasum >/dev/null 2>&1; then
  say "  sha256  : $(shasum -a 256 "$target" | cut -d' ' -f1)"
elif command -v sha256sum >/dev/null 2>&1; then
  say "  sha256  : $(sha256sum "$target" | cut -d' ' -f1)"
fi
say ""

if [ "${LAZYFOX_NO_RUN:-0}" = "1" ]; then
  say "Downloaded: $target"
  exit 0
fi

# --- run ---------------------------------------------------------------------
# When this script was piped (`curl … | sh`), stdin is the script, not a
# terminal. The installer is interactive, so re-attach the controlling terminal
# before launching. Without a terminal we still run it (a GUI build needs none).
if [ -r /dev/tty ]; then
  exec < /dev/tty
fi

exec "$target"
