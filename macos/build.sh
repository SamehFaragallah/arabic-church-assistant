#!/bin/bash
# Builds the Mac download: "Arabic Church Assistant.app" with the small speech engine (Google through Chrome, and the
# paid services), the Bibles and the fonts, zipped into dist/. Run it on a Mac, in Terminal, from the app's folder:
#
#   bash macos/build.sh arm64     Macs with an Apple chip (M1 and newer), macOS 14 or newer
#   bash macos/build.sh x64       Macs with an Intel processor, macOS 13 or newer (on an Apple-chip Mac: needs Rosetta)
#
# Signed with your Apple Developer ID and notarized by Apple (opens on any Mac without warnings):
#   MAC_SIGN_ID="Developer ID Application: Your Name (TEAMID)" MAC_NOTARY_PROFILE=ACA bash macos/build.sh arm64
# Without MAC_SIGN_ID it is signed "ad hoc": it works, but each Mac asks for it to be allowed once. macos/README.md has
# the one-time steps. Nothing personal goes in: settings, history, logs and recordings are made on each Mac, in
# ~/Library/Application Support/Arabic Church Assistant.
set -euo pipefail
ARCH="${1:-arm64}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
NAME="Arabic Church Assistant"
VERSION="$(plutil -extract version raw -o - "$SRC/package.json" 2>/dev/null || sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$SRC/package.json")"
ELECTRON="$(plutil -extract devDependencies.electron raw -o - "$SRC/package.json" 2>/dev/null || sed -n 's/^    "electron": *"\([^"]*\)".*/\1/p' "$SRC/package.json")"
PBS="https://github.com/astral-sh/python-build-standalone/releases/download/20261110"
SIGN="${MAC_SIGN_ID:--}"

# The newest packages made for each kind of Mac. (onnxruntime, for the voice detector, stopped making them for Intel
# Macs after 1.23, and only for Python 3.13 and older.)
if [ "$ARCH" = arm64 ]; then
  LABEL=AppleSilicon; MIN_MACOS=14.0; PLATFORM=macosx_14_0_arm64; PV=3.14
  PY_FILE=cpython-3.14.10+20261110-aarch64-apple-darwin-install_only_stripped.tar.gz
  PY_SHA=f15ec3d15460dd66c2eb88639b152cd9040e7d1ece11e38bf89e8f53f0171e02
  E_SHA=25ae0ce40ee462433c1029b8fcc485949fc8a89394b62b70887d7793898edc89
  PACKAGES="numpy==2.5.5 onnxruntime==1.32.0 av==19.0.2 sounddevice==0.5.6 soundcard==0.4.6 websockets==17.4"
elif [ "$ARCH" = x64 ]; then
  LABEL=Intel; MIN_MACOS=13.0; PLATFORM=macosx_13_0_x86_64; PV=3.13
  PY_FILE=cpython-3.13.18+20261110-x86_64-apple-darwin-install_only_stripped.tar.gz
  PY_SHA=d27d59a722db9f69926eb6d9564071247221f45a04da920ea7f3001c97e32f9b
  E_SHA=151d249b646eb8b99f1bea40aff217b10d8e21246ad8c07bb3a5982e2722660f
  PACKAGES="numpy==2.5.5 onnxruntime==1.23.2 av==19.0.2 sounddevice==0.5.6 soundcard==0.4.6 websockets==17.4"
else
  echo "arm64 or x64, not $ARCH" >&2; exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/$NAME.app"
echo "== Arabic Church Assistant $VERSION for Mac ($LABEL): Electron $ELECTRON, Python $PV, signed by: $SIGN"

# ---- the desktop app: Electron for Mac, renamed
E_ZIP="electron-v$ELECTRON-darwin-$ARCH.zip"
echo "-- Electron"
curl -fsSL --retry 3 -o "$WORK/$E_ZIP" "https://github.com/electron/electron/releases/download/v$ELECTRON/$E_ZIP"
echo "$E_SHA  $WORK/$E_ZIP" | shasum -a 256 -c - >/dev/null
ditto -x -k "$WORK/$E_ZIP" "$WORK/electron"
mv "$WORK/electron/Electron.app" "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$NAME"
rm -f "$APP/Contents/Resources/default_app.asar" "$APP/Contents/Resources/electron.icns"
# (the English and Arabic texts of Chromium's own menus and dialogs are kept; the other 50 languages are not needed)
find "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources" -maxdepth 1 -name '*.lproj' \
  ! -name 'en.lproj' ! -name 'en_GB.lproj' ! -name 'ar.lproj' -exec rm -rf {} +
PL="$APP/Contents/Info.plist"
set_plist() { plutil -replace "$1" -string "$2" "$PL"; }
set_plist CFBundleExecutable "$NAME"
set_plist CFBundleName "$NAME"
set_plist CFBundleDisplayName "$NAME"
set_plist CFBundleIdentifier "io.github.samehfaragallah.arabicchurchassistant"
set_plist CFBundleShortVersionString "$VERSION"
set_plist CFBundleVersion "$VERSION"
set_plist CFBundleIconFile "icon.icns"
set_plist LSMinimumSystemVersion "$MIN_MACOS"
set_plist NSHumanReadableCopyright "Sameh Welson Faragallah"
set_plist NSMicrophoneUsageDescription "Arabic Church Assistant listens to the pastor's microphone to find the Bible verses and hymns he mentions."

# ---- the icon (from electron/icon.png)
ICONSET="$WORK/icon.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$SRC/electron/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$SRC/electron/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

# ---- the app's own files (as in the Windows download, without what only Windows uses)
echo "-- the app's files"
R="$APP/Contents/Resources/app"
mkdir -p "$R/engine" "$R/data"
cp "$SRC/package.json" "$SRC/server.js" "$SRC/speech.js" "$SRC/bible-keys.json" "$R/"
cp -R "$SRC/electron" "$SRC/public" "$R/"
rm -f "$R/electron/shortcut.ps1" "$R/electron/icon.ico"
for f in asr.py audio_io.py cloud.py engine.py live.py google.html silero_vad.onnx; do cp "$SRC/engine/$f" "$R/engine/"; done
for f in ar_svd.json ar_vandyke.json en_asv.json en_bsb.json en_kjv.json en_web.json songs.json apibible-bibles.json README.txt; do
  cp "$SRC/data/$f" "$R/data/"
done
cp -R "$SRC/data/fonts" "$R/data/"

# ---- the speech engine's Python (python-build-standalone) and the packages for Google and the paid services
echo "-- Python $PV and its packages"
curl -fsSL --retry 3 -o "$WORK/python.tar.gz" "$PBS/$PY_FILE"
echo "$PY_SHA  $WORK/python.tar.gz" | shasum -a 256 -c - >/dev/null
tar -xzf "$WORK/python.tar.gz" -C "$WORK"
PYH="$WORK/python"
PY="$PYH/bin/python3"
SITE="$PYH/lib/python$PV/site-packages"
"$PY" -m pip --version >/dev/null 2>&1 || "$PY" -m ensurepip >/dev/null
# (--platform: wheels that also run on the oldest macOS the app supports, not only on this Mac's)
"$PY" -m pip install --quiet --no-cache-dir --disable-pip-version-check --only-binary=:all: --platform "$PLATFORM" \
  --target "$SITE" --upgrade $PACKAGES
# what isn't needed: pip itself, Tk, IDLE, the test suite, C headers, the static library, manual pages
rm -rf "$SITE"/pip "$SITE"/pip-*.dist-info "$SITE/bin" "$PYH/include" "$PYH/share" "$PYH"/lib/tcl* "$PYH"/lib/tk* "$PYH"/lib/itcl* \
  "$PYH"/lib/thread* "$PYH"/lib/tdbc* "$PYH/lib/python$PV/"{idlelib,tkinter,turtledemo,ensurepip,test} \
  "$PYH/lib/python$PV/"config-* "$PYH/lib/python$PV/lib-dynload/"_tkinter*
find "$PYH" -name '__pycache__' -type d -prune -exec rm -rf {} +
echo "light (cloud speech only)" > "$PYH/ready.txt"
mv "$PYH" "$R/engine/python"
"$R/engine/python/bin/python3" -c "import numpy, onnxruntime, av, sounddevice, soundcard, websockets; print('   numpy', numpy.__version__, '· onnxruntime', onnxruntime.__version__, '· av', av.__version__)"
# Compiled here once, so the app never writes inside itself (the Mac would then see it as changed): "unchecked-hash"
# copies are used as they are.
"$R/engine/python/bin/python3" -m compileall -q -j 0 --invalidation-mode unchecked-hash "$R/engine" >/dev/null || true

# ---- signing: every program and library inside first, then the frameworks and helper apps, then the app
echo "-- signing"
OPTS=()
if [ "$SIGN" != "-" ]; then OPTS=(--timestamp --options runtime --entitlements "$SRC/macos/entitlements.plist"); fi
sign() { codesign --force --sign "$SIGN" ${OPTS[@]+"${OPTS[@]}"} "$1"; }
find "$APP/Contents" -type f \( -perm -0100 -o -name '*.so' -o -name '*.dylib' \) -print0 |
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q 'Mach-O'; then sign "$f"; fi
  done
find "$APP/Contents/Frameworks" -depth -type d \( -name '*.framework' -o -name '*.app' \) -print0 |
  while IFS= read -r -d '' b; do sign "$b"; done
sign "$APP"
codesign --verify --deep --strict "$APP"
echo "   signature checked"

# ---- notarized by Apple (with MAC_NOTARY_PROFILE: see macos/README.md), so every Mac opens it without warnings
if [ "$SIGN" != "-" ] && [ -n "${MAC_NOTARY_PROFILE:-}" ]; then
  echo "-- notarizing (a few minutes)"
  ditto -c -k --keepParent "$APP" "$WORK/notarize.zip"
  out="$(xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$MAC_NOTARY_PROFILE" --wait 2>&1 || true)"
  echo "$out" | sed 's/^/   /'
  if ! echo "$out" | grep -q 'status: Accepted'; then
    id="$(echo "$out" | awk '/^ *id:/ { print $2; exit }')"
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$MAC_NOTARY_PROFILE" || true
    echo "Apple did not accept it (above: why)." >&2; exit 1
  fi
  xcrun stapler staple "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
fi

# ---- the zip: one app inside
mkdir -p "$SRC/dist"
ZIP="$SRC/dist/Arabic-Church-Assistant-$VERSION-Mac-$LABEL.zip"
rm -f "$ZIP"
(cd "$WORK" && ditto -c -k --sequesterRsrc --keepParent "$NAME.app" "$ZIP")
echo "== done"
echo "app: $(du -sh "$APP" | cut -f1) · zip: $(du -h "$ZIP" | cut -f1), $(stat -f %z "$ZIP") bytes"
echo "sha256: $(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
echo "$ZIP"
