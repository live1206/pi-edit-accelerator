#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:-$PWD}
if [[ ! -d "$target" ]]; then
  echo "Pilot working directory does not exist: $target" >&2
  exit 1
fi

cd "$repo"
npm run native:build
pilot_dir=${PI_EDIT_ACCELERATOR_PILOT_DIR:-$repo/.artifacts/native-pilot}
cd "$target"
exec env \
  PI_EDIT_ACCELERATOR_NATIVE_PATH="$repo/native/pi-edit-accelerator-native.linux-x64-gnu.node" \
  PI_EDIT_ACCELERATOR_PILOT_DIR="$pilot_dir" \
  pi -e "$repo/extensions/edit-accelerator.ts"
