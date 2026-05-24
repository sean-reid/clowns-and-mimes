#!/usr/bin/env bash
# Launches Godot against the deployed dev backend so the editor build talks to
# the live cm-matchmaker-dev worker. Falls back to printing instructions if
# godot is not on PATH.
#
# Godot only imports resources on first editor open or via an explicit
# --import pass. Running the project directly on a fresh checkout skips this,
# so .mp3 streams and .png textures silently fail to load (audio is silent,
# textures are blank). We run --import once up front when the cache is empty.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${ROOT}/game"
export CLOWNS_MM_URL="${CLOWNS_MM_URL:-https://cm-matchmaker-dev.seanreid.workers.dev}"

GODOT_BIN=""
if command -v godot >/dev/null 2>&1; then
  GODOT_BIN="$(command -v godot)"
elif [ -x "/Applications/Godot.app/Contents/MacOS/Godot" ]; then
  GODOT_BIN="/Applications/Godot.app/Contents/MacOS/Godot"
fi

if [ -z "${GODOT_BIN}" ]; then
  cat <<EOF
Godot binary not found on PATH. Open the editor at:

  ${PROJECT}/project.godot

with the environment variable CLOWNS_MM_URL pre-exported, or set it inside
the editor's run command.
EOF
  exit 1
fi

if [ ! -d "${PROJECT}/.godot/imported" ]; then
  echo "First-run import (this takes a moment for the oompa theme)..."
  "${GODOT_BIN}" --headless --path "${PROJECT}" --import
fi

echo "Pointing the game at: ${CLOWNS_MM_URL}"
exec "${GODOT_BIN}" --path "${PROJECT}"
