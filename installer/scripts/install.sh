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
#   LAZYFOX_TUI=1             force the terminal installer instead of the window
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

rel_url_for() { # asset
  if [ "$CHANNEL" = "nightly" ]; then
    printf 'https://%s/releases/download/nightly/%s\n' "$REPO" "$1"
  else
    printf 'https://%s/releases/latest/download/%s\n' "$REPO" "$1"
  fi
}

# Does a release asset exist? A HEAD request, 404-safe: a channel that has not
# published an AppImage yet answers "no" instead of a failed download. Empty
# output on curl means the request failed outright — treat that as "no" too, so
# the fallback logic runs rather than assuming the asset is there.
asset_exists() { # asset name -> yes|no
  local url="$(rel_url_for "$1")"
  if command -v curl >/dev/null 2>&1; then
    [ -n "$(curl -fsIL -o /dev/null -w '%{http_code}' --head "$url" 2>/dev/null | grep -E '^(2|30)[0-9]$')" ] && printf yes || printf no
  elif command -v wget >/dev/null 2>&1; then
    wget --spider -q "$url" 2>/dev/null && printf yes || printf no
  else
    # No way to look: try the preferred asset anyway (the download itself will
    # report a missing file).
    printf yes
  fi
}

# The graphical installer for this machine (the default), plus — linux only —
# the pure-Go terminal fallback.
#
# On linux the FIRST choice is the bundled AppImage: it carries its own
# WebKitGTK and even the helper processes libwebkit spawns from a path baked
# into the library, so the graphical installer starts on any desktop without
# asking the machine for libwebkit2gtk-4.0 at all — the missing-package state
# that used to leave linux users with a shared-library error or a text
# fallback. The AppImage is published per channel; a channel that has not
# caught up yet (no asset yet) answers "no" to a HEAD probe and falls through
# to the old probe-and-fallback logic below.
#
# LAZYFOX_TUI: unset → AppImage if published, else probe GUI ELF and fall back
# automatically; 1 → always the terminal installer; 0 → always the graphical
# ELF GUI, no probe (the ELF still needs the system libwebkit). Only linux
# ships the -tui download at all (macOS always has WKWebView).
asset="lazyfox-install$([ "$CHANNEL" = "nightly" ] && printf -- '-dev')-$machine"
if [ "$machine" = "linux" ]; then
  appimage="lazyfox-install$([ "$CHANNEL" = "nightly" ] && printf -- '-dev')-linux.AppImage"
  if [ "${LAZYFOX_TUI-}" != "1" ] && [ "$(asset_exists "$appimage")" = "yes" ]; then
    asset="$appimage"
  else
    tui_pref="${LAZYFOX_TUI-}"
    if [ "$tui_pref" = "1" ]; then
      asset="${asset}-tui"
    elif [ -z "$tui_pref" ]; then
      # A library probe is a fast, accurate pre-check; ldconfig reads the same
      # ELF dependency data the dynamic loader itself would use, so it misses
      # nothing above the four-point-oh library line.
      if ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4\.0'; then
        say "note: no bundled AppImage for this channel, and no libwebkit2gtk-4.0 on this machine."
        say "      Using the terminal installer (every release ships it too)."
        say "      (The package is called 'webkit2gtk-4.0' on most distros; after installing it,"
        say "       LAZYFOX_TUI=0 puts the graphical window back.)"
        asset="${asset}-tui"
      fi
    fi
  fi
fi
url="$(rel_url_for "$asset")"

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

if [ "${target##*.}" = "AppImage" ]; then
  # An AppImage normally mounts itself through FUSE. A machine without the
  # module (older containers, some minimal installs) can still run the very
  # same program through the AppImage's built-in extraction mode — the layout
  # of "/dev/fuse + fusermount + fusermount3" varies by distro, so probe ALL
  # the pieces instead of assuming one path names the capability.
  if [ -e /dev/fuse ] && { command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1; }; then
    exec "$target"
  else
    exec "$target" --appimage-extract-and-run
  fi
else
  exec "$target"
fi
