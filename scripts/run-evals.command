#!/bin/bash
# Double-click in Finder (or run from Terminal) to run the evals against the
# local model server the app uses (oMLX by default). Local Kovach can stay open.
# The report goes to logs/evals/latest.md; output is also in logs/evals.log.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs/evals
exec > >(tee "logs/evals.log") 2>&1

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +u
  . "$NVM_DIR/nvm.sh"
  set -u
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI=true
export npm_config_confirm_modules_purge=false
if command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  PNPM=(npx --yes pnpm@10.28.0)
fi

"${PNPM[@]}" install --config.confirm-modules-purge=false < /dev/null
echo "== install done =="
"${PNPM[@]}" --filter @kovach-dev/evals eval "$@"
echo "== evals done =="
