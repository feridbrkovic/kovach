#!/bin/bash
# Double-click in Finder (or run from Terminal) to download the model Local Kovach runs on,
# Qwen3.6-35B-A3B in 4-bit MLX form (about 20 GB), into oMLX's model folder. An interrupted
# download picks up where it stopped when you run this again. Output is also written to
# logs/get-model.log.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
exec > >(tee "logs/get-model.log") 2>&1

REPO="mlx-community/Qwen3.6-35B-A3B-4bit"
# The exact version Local Kovach was tested with (17 Nov 2026).
REVISION="38740b847e4cb78f352aba30aa41c76e08e6eb46"
DEST="$HOME/.omlx/models/$REPO"
# The four weight files and their sizes in bytes, to check the download.
EXPECTED=(
  "model-00001-of-00004.safetensors 5288196018"
  "model-00002-of-00004.safetensors 5368472749"
  "model-00003-of-00004.safetensors 5368324139"
  "model-00004-of-00004.safetensors 4377211365"
)

echo "Model:  $REPO"
echo "Into:   $DEST"

complete() {
  for line in "${EXPECTED[@]}"; do
    set -- $line
    [ -f "$DEST/$1" ] && [ "$(stat -f %z "$DEST/$1" 2>/dev/null || stat -c %s "$DEST/$1")" = "$2" ] || return 1
  done
}

if complete; then
  echo "The model is already here and complete. Nothing to do."
  exit 0
fi

# About 21 GB free is needed (the files plus a little room).
free_kb=$(df -k "$HOME" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt $((21 * 1024 * 1024)) ]; then
  echo "Not enough free space: about 21 GB is needed, $((free_kb / 1024 / 1024)) GB is free."
  exit 1
fi

# The Hugging Face command-line tool: the one installed with oMLX, then any on PATH, then a temporary one.
if [ -x "$HOME/.hf-cli/venv/bin/hf" ]; then
  HF=("$HOME/.hf-cli/venv/bin/hf")
elif command -v hf >/dev/null 2>&1; then
  HF=(hf)
elif command -v uvx >/dev/null 2>&1; then
  HF=(uvx --from huggingface_hub hf)
else
  echo "Installing the Hugging Face download tool (once)…"
  curl -LsSf https://hf.co/cli/install.sh | bash
  HF=("$HOME/.hf-cli/venv/bin/hf")
fi

mkdir -p "$DEST"
"${HF[@]}" download "$REPO" --revision "$REVISION" --local-dir "$DEST"

if complete; then
  echo
  echo "Done. Next:"
  echo "  1. Open oMLX (or restart it if it was running) so it sees the model."
  echo "  2. Start Local Kovach with scripts/start-mac.command."
  echo "  3. In Local Kovach: Settings → Test connection."
else
  echo
  echo "The download finished but some files are missing or the wrong size. Run this again to resume."
  exit 1
fi
