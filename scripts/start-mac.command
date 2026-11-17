#!/bin/bash
# Double-click in Finder (or run from Terminal) to install dependencies and
# start Local Kovach in development mode. Output is also written to
# logs/start.log.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
exec > >(tee "logs/start.log") 2>&1

echo "Local Kovach: $(pwd)"

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
echo "Node $(node -v)"

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
"${PNPM[@]}" --filter @kovach-dev/desktop dev
