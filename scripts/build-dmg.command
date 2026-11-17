#!/bin/bash
# Double-click in Finder (or run from Terminal) to build an Apple Silicon DMG of
# Local Kovach. The app is ad-hoc signed, not notarized. Output is also written
# to logs/build-dmg.log.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
exec > >(tee "logs/build-dmg.log") 2>&1

echo "Local Kovach DMG build: $(pwd)"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "The DMG can only be built on a Mac with Apple Silicon (this is $(uname -s) $(uname -m))."
  exit 1
fi

# Node.js 22 or newer, through nvm when it is installed.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +u
  . "$NVM_DIR/nvm.sh"
  set -u
fi
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  if command -v nvm >/dev/null 2>&1; then
    set +u; nvm install 22; nvm use 22; set -u
  else
    echo "Local Kovach needs Node.js 22 or newer. Install it from https://nodejs.org and run this again."
    read -r -p "Press Return to close." _
    exit 1
  fi
fi
echo "Node $(node -v) ($(node -p process.arch))"

# The native module is built for Node's architecture, so Node must be arm64
# (an x64 Node running under Rosetta would produce an x64 binary).
if [ "$(node -p process.arch)" != "arm64" ]; then
  echo "Node is running as $(node -p process.arch). Install the arm64 build of Node.js and run this again."
  exit 1
fi

# pnpm, in the version package.json asks for.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Non-interactive: never block on pnpm's "reinstall modules?" TTY prompt.
export CI=true
# Never block on the "reinstall modules from scratch?" confirmation.
export npm_config_confirm_modules_purge=false
if command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  PNPM=(npx --yes pnpm@10.28.0)
fi
echo "pnpm $("${PNPM[@]}" --version)"

"${PNPM[@]}" install --config.confirm-modules-purge=false < /dev/null
echo "== install done =="

"${PNPM[@]}" --filter @kovach-dev/desktop native
echo "== native module done =="

rm -rf apps/desktop/release
"${PNPM[@]}" --filter @kovach-dev/desktop dist
echo "== dist done =="

RELEASE_DIR="$(pwd)/apps/desktop/release"
APP="$RELEASE_DIR/mac-arm64/Local Kovach.app"
DMG="$(ls -t "$RELEASE_DIR"/*.dmg 2>/dev/null | head -n 1 || true)"
if [ -z "$DMG" ]; then
  echo "No .dmg was produced in $RELEASE_DIR."
  exit 1
fi

# The app can't open its database without these two files.
missing=0
for f in \
  "$APP/Contents/Resources/native/better_sqlite3.node" \
  "$APP/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec-darwin-arm64/vec0.dylib"; do
  if [ ! -f "$f" ]; then
    echo "Missing from the app bundle: $f"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then exit 1; fi

if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "Ad-hoc signature verified."
else
  echo "Warning: codesign could not verify $APP; macOS may refuse to open it."
fi

echo
echo "DMG: $DMG"
echo "The app is not notarized. On another Mac, open it the first time with"
echo "right-click > Open, or allow it in System Settings > Privacy & Security."
open -R "$DMG"
