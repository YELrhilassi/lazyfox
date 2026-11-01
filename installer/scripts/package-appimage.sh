#!/usr/bin/env bash
# Package the Linux GUI installer as a fully self-contained AppImage.
#
# Why this exists: the GUI installer links WebKitGTK through Wails' cgo backend.
# On a desktop without the exact `libwebkit2gtk-4.0` package the binary dies with
#
#   error while loading shared libraries: libwebkit2gtk-4.0.so.37
#
# before it ever shows a window — most modern distros ship only the 4.1 sibling.
# And bundling the library alone is NOT enough, which is what every naive "ldd
# and copy" AppImage gets wrong: libwebkit spawns WebKitWebProcess and
# WebKitNetworkProcess from a path BAKED INTO THE LIBRARY (usually
# /usr/lib/x86_64-linux-gnu/webkit2gtk-4.0). So the AppImage must
#
#   (a) ship the whole helper directory, mirrored at that absolute path,
#   (b) byte-patch the baked path IN PLACE (equal length, NUL-terminated!) to a
#       relative one — appending/stripping the leading "/" shifts every byte
#       after it and corrupts the ELF (that exact "sed s|/usr|./usr|g" bug is
#       documented and answered as "nothing changed" in wails discussion 4320),
#   (c) chdir the process into the AppDir before exec, so the relative path
#       resolves into the squashfs mount.
#
# WARNING about the pins: a release tag that does not exist 404s the whole
# packaging (the 1-alpha-20240109 pin was missing its "-1" suffix and every
# download died before a build started). Verify the tag against the release
# list before bumping: linuxdeploy names alphas 1-alpha-YYYYMMDD-*.
#
# The dependency closure and the GTK module caches come from linuxdeploy (+ the
# gtk plugin), the watch on "nothing is missing at runtime" is a plain ldd gate,
# and appimagetool does the packaging. It must run on the native Linux build
# machine — today the ubuntu-22.04 job in .github/workflows/installers.yml —
# because the GUI binary is cgo-linked to that platform.
#
#   package-appimage.sh --bin <gui installer binary> --out <AppImage> \
#                       [--appdir <work dir>] [--arch x86_64]
#
# Env overrides: WEBKIT_LIBEXEC (the WebKit helper dir), the three tool tag
# pins, APPIMAGE_TOOLS_DIR (tool cache; default /tmp/lazyfox-appimage-tools).
#
# GStreamer is deliberately NOT bundled. The installer window is a static form
# UI: it never plays media, so it never loads a GStreamer plugin, and exporting
# GST_PLUGIN_SYSTEM_PATH* into an empty bundled dir is the well-documented way
# to make WebKit SIGABRT the first time ANYTHING plays audio (screenpipe 5529).
# Not setting those variables leaves the host's scan alive, which is the safe
# side of "either bundle fully or not at all".
set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'package-appimage: %s\n' "$*" >&2; exit 1; }

BIN=""
OUT=""
APPDIR_ARG=""
ARCH="x86_64"

while [ $# -gt 0 ]; do
  case "$1" in
    --bin)    BIN="${2-}"; shift 2 ;;
    --out)    OUT="${2-}"; shift 2 ;;
    --appdir) APPDIR_ARG="${2-}"; shift 2 ;;
    --arch)   ARCH="${2-x86_64}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$BIN" ] || die "--bin is required (the native GUI installer binary)"
[ -n "$OUT" ] || die "--out is required (the AppImage file to write)"
[ -f "$BIN" ] || die "binary not found: $BIN"

# Absolute paths at the boundary. Later steps change directory (the smoke cd's
# into a scratch dir), and a relative --out/--bin passed by an invoking CI step
# then resolves from the wrong cwd — observed as "No such file or directory" on
# an AppImage that had just been written successfully.
BIN="$(readlink -f "$BIN")"
OUT="$(readlink -f "$OUT")"

command -v python3  >/dev/null 2>&1 || die "python3 is required for the WebKit byte-patch"
command -v ldd      >/dev/null 2>&1 || die "ldd is required for the runtime gate"
command -v file     >/dev/null 2>&1 || die "file is required to sanity-check the binary"

# --- the three AppImage tools, pinned and cached -----------------------------------
TAG_LINUXDEPLOY="${LINUXDEPLOY_TAG:-1-alpha-20251107-1}"
TAG_APPIMAGETOOL="${APPIMAGETOOL_TAG:-continuous}"
TAG_RUNTIME="${TYPE2_RUNTIME_TAG:-continuous}"

TOOLS_DIR="${APPIMAGE_TOOLS_DIR:-/tmp/lazyfox-appimage-tools}"
mkdir -p "$TOOLS_DIR"

fetch_tool() { # <url> <local name> -> prints the local path
  local url="$1" dst="$TOOLS_DIR/$2"
  if [ ! -s "$dst" ]; then
    # Progress goes to STDERR, deliberate: this function is command-substituted
    # (its stdout IS the tool path), and a stdout progress line would become
    # part of the value — observed on CI as LINUXDEPLOY = "[appimage] fetching
    # <url>\n/tmp/...AppImage", which bash then tries to run as two commands.
    say "[appimage] fetching $url" >&2
    if command -v curl >/dev/null 2>&1; then
      curl -fL --proto '=https' --tlsv1.2 -o "$dst" "$url" || die "download failed: $url"
    else
      wget -q -O "$dst" "$url" || die "download failed: $url"
    fi
  fi
  chmod +x "$dst"
  printf '%s\n' "$dst"
}

LINUXDEPLOY="$(fetch_tool \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/${TAG_LINUXDEPLOY}/linuxdeploy-${ARCH}.AppImage" \
  "linuxdeploy-${ARCH}.AppImage")"
APPIMAGETOOL="$(fetch_tool \
  "https://github.com/AppImage/appimagetool/releases/download/${TAG_APPIMAGETOOL}/appimagetool-${ARCH}.AppImage" \
  "appimagetool-${ARCH}.AppImage")"
RUNTIME="$(fetch_tool \
  "https://github.com/AppImage/type2-runtime/releases/download/${TAG_RUNTIME}/runtime-${ARCH}" \
  "runtime-${ARCH}")"

run_linuxdeploy() { "$LINUXDEPLOY" --appimage-extract-and-run "$@"; }
run_appimagetool() { "$APPIMAGETOOL" --appimage-extract-and-run "$@"; }

# --- locate the WebKit helper directory (4.0 preferred, 4.1 accepted) ---------------
WEBKIT_LIBEXEC="${WEBKIT_LIBEXEC:-/usr/lib/x86_64-linux-gnu/webkit2gtk-4.0}"
if [ ! -d "$WEBKIT_LIBEXEC" ]; then
  WEBKIT_LIBEXEC="/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"
fi
[ -d "$WEBKIT_LIBEXEC" ] || \
  die "no webkit2gtk helper directory found (looked for 4.0 then 4.1 under /usr/lib/x86_64-linux-gnu)"

# The bundled library's major must MATCH the helper directory's major, or this
# AppImage ships 4.x helpers next to a 4.y library. ldd is the authoritative
# answer to "which webkit does the binary WANT?" because pkg-config may shadow an
# older dev package on the build machine.
NEEDED_WK="$(ldd "$BIN" | grep -o 'libwebkit2gtk-[0-9.]*\.so' | head -n 1 || true)"
NEEDED_WK="${NEEDED_WK#libwebkit2gtk-}"; NEEDED_WK="${NEEDED_WK%.so}"
BUNDLED_WK="${WEBKIT_LIBEXEC##*webkit2gtk-}"
[ "$NEEDED_WK" = "$BUNDLED_WK" ] || \
  die "the binary needs libwebkit2gtk-${NEEDED_WK} but the helper dir is ${BUNDLED_WK} — install the matching dev package and repackage"

# --- AppDir: binary, desktop entry, icon --------------------------------------------
APPDIR="${APPDIR_ARG:-$(mktemp -d /tmp/lazyfox-appdir.XXXXXX)}"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/apprun-hooks"
cp "$BIN" "$APPDIR/usr/bin/lazyfox-install"
chmod +x "$APPDIR/usr/bin/lazyfox-install"
file "$APPDIR/usr/bin/lazyfox-install" | grep -q ELF || die "not an ELF binary: $BIN"

cat > "$APPDIR/lazyfox-install.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Lazyfox installer
GenericName=Firefox add-on installer
Comment=Install the Lazyfox keyboard layer into Firefox
Exec=lazyfox-install
Icon=lazyfox-install
Categories=Utility;
StartupNotify=true
EOF

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Icons must ALREADY be inside the AppDir named after the desktop entry's
# Icon=lazyfox-install, sized from the real per-size sources. The old
# `--icon-file winres/icon256.png` was wrong: linuxdeploy keeps the FILE's
# basename (…/256x256/apps/icon256.png) and then fails the desktop deployment
# with "Could not find suitable icon for Icon entry: lazyfox-install".
for size in 256 128 64 48 32 16; do
  src="$SCRIPT_DIR/winres/icon${size}.png"
  [ -f "$src" ] || src="$SCRIPT_DIR/winres/icon256.png"
  dst="$APPDIR/usr/share/icons/hicolor/${size}x${size}/apps/lazyfox-install.png"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
done

mkdir -p "$APPDIR$WEBKIT_LIBEXEC"
cp -a "$WEBKIT_LIBEXEC"/. "$APPDIR$WEBKIT_LIBEXEC/"

# --- linuxdeploy pass 1: deploy the dependency closure + GTK integration ------------
say "[appimage] deploying dependencies ($APPDIR)"
NO_STRIP=1 DEPLOY_GTK_VERSION=3 run_linuxdeploy \
  --appdir "$APPDIR" \
  --desktop-file "$APPDIR/lazyfox-install.desktop" || die "linuxdeploy (pass 1) failed"

# --- linuxdeploy pass 2: the WebKit helpers' own dependency closure ------------------
# Nothing links the helper executables, so pass 1 never copies their deps — and a
# helper that cannot dlopen its own gtk/gio/webkit libs dies exactly as the main
# binary would have, two screens deeper and much harder to reproduce.
for helper in WebKitWebProcess WebKitNetworkProcess WebKitGPUProcess; do
  f="$APPDIR$WEBKIT_LIBEXEC/$helper"
  [ -f "$f" ] || continue
  say "[appimage] deploying helper deps: $helper"
  NO_STRIP=1 run_linuxdeploy \
    --appdir "$APPDIR" \
    --deploy-deps-only="$f" || die "linuxdeploy (helper $helper) failed"
done

# --- the WebKit byte-patch: baked absolute helper path -> relative -------------------
# The file must be the LIBRARY itself: linuxdeploy also copies the dpkg
# copyright doc (…/doc/libwebkit2gtk-4.0-37/copyright), whose path contains
# the same substring and would otherwise be 'patched' — a text file with no
# baked ELF string, and a hard assert in the patcher below.
WK_LIB="$(find "$APPDIR/usr" -type f -o -type l | grep '/libwebkit2gtk-[0-9.]*\.so' | head -n 1)"
[ -n "$WK_LIB" ] || die "libwebkit2gtk was not deployed into the AppDir"
REAL_LIB="$(readlink -f "$WK_LIB")"
say "[appimage] patching helper path in $(basename "$REAL_LIB")"
python3 - "$REAL_LIB" "$WEBKIT_LIBEXEC" <<'PY'
import pathlib
import sys

lib_path, old = pathlib.Path(sys.argv[1]).resolve(), sys.argv[2]
# Same length, same bytes except for the leading "/": `usr//lib/...` is
# NUL-padded to exactly the length the baked-in string occupied. Padding with a
# doubled slash rather than shuffling means every other baked string in the file
# (the injected-bundle path under the same prefix) keeps its exact position.
new = old[1:]
cut = new.index("/")
new = new[:cut] + "/" + new[cut:]
assert len(new) == len(old) and "/usr" + new[1 + 3:] == old, "the relative rewrite is not length-preserving"
new_b, old_b = new.encode() + b"\0", old.encode() + b"\0"
data = pathlib.Path(str(lib_path)).read_bytes()
count = data.count(old_b)
assert count >= 1, f"no baked '{old}\\0' occurrences found in {lib_path}"
lib_path.write_bytes(data.replace(old_b, new_b))
print(f"patched {count} occurrence(s) of {old} -> {new} in {lib_path}")
PY

# --- AppRun: fetch the plugin's env hook, chdir for the patched path, NVIDIA guard --
cat > "$APPDIR/apprun-hooks/zz-webkit-cwd.sh" <<'EOF'
# The bundled libwebkit spawns its WebKitWebProcess / WebKitNetworkProcess
# helpers through a path that was byte-patched to be relative to the AppDir
# root, so the process must chdir there before exec. Sourced LAST by this
# AppRun so every other hook's $APPDIR-dependent exports stay valid: those
# compute paths FROM $APPDIR, and chdir does not touch $APPDIR itself.
cd "$APPDIR" || exit 1
# WebKitGTK's DMABUF renderer renders a blank window on NVIDIA's proprietary
# driver — the same mitigation the Wails docs apply on exactly this condition,
# opt-out kept in the environment for a user who wants the faster path anyway.
if [ -d /sys/module/nvidia ]; then
  export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
fi
EOF

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
# Defines APPDIR first (every hook is written against it), sources every hook,
# then execs the real installer. No listener, no browser: the AppImage is just
# the installer's own window, portable.
HERE="$(readlink -f "${0%/*}")"
APPDIR="$HERE"
for hook in "$APPDIR"/apprun-hooks/*.sh; do
  [ -e "$hook" ] || continue
  # shellcheck source=/dev/null
  source "$hook"
done
exec "$APPDIR/usr/bin/lazyfox-install" "$@"
EOF
chmod +x "$APPDIR/AppRun" "$APPDIR"/apprun-hooks/*.sh

# --- the runtime gate: nothing may be left unresolved --------------------------------
MISSING="$(ldd "$APPDIR/usr/bin/lazyfox-install" 2>/dev/null | grep 'not found' || true)"
[ -z "$MISSING" ] || die "unresolved dependencies after deploy:
$MISSING"

HELPERS="$(ls "$APPDIR$WEBKIT_LIBEXEC" 2>/dev/null | grep -c WebKit || true)"
[ "${HELPERS:-0}" -ge 1 ] || die "no WebKit helper processes in $APPDIR$WEBKIT_LIBEXEC"

# --- pack ------------------------------------------------------------------------------
rm -f "$OUT"
say "[appimage] packing $OUT"
ARCH="$ARCH" run_appimagetool --runtime-file "$RUNTIME" "$APPDIR" "$OUT" || die "appimagetool failed"

# --- prove it out of the box: the packed AppRun runs --mode list headlessly -------------
# The same steps the runtime's extract-and-run does, but as an explicit extract
# followed by `bash -x AppRun`: if anything inside the AppDir is wrong (a path,
# a hook, an entry point) the xtrace names the failing line and its argument
# directly in the log, instead of leaving one unexplained error line to decode
# from outside.
smoke_dir="$(mktemp -d /tmp/lazyfox-smoke.XXXXXX)"
(
  cd "$smoke_dir"
  timeout 120 "$OUT" --appimage-extract >/dev/null
) || die "the packed AppImage is not extractable"
SQUASH="$smoke_dir/squashfs-root"
say "[appimage] (debug) usr/bin entries:"
ls -la "$SQUASH/usr/bin"
(
  cd "$SQUASH"
  timeout 120 bash -x ./AppRun --mode list >/dev/null
) || die "the packed AppRun failed --mode list"
rm -rf "$smoke_dir"

say "[appimage] OK: $OUT"

# APPDIR was a scratch dir we created; leave a user-provided one alone.
if [ -z "$APPDIR_ARG" ]; then
  rm -rf "$APPDIR"
fi
