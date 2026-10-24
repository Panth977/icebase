#!/usr/bin/env bash
# Rebuild IceBase and copy its dist/ into another project's installed copies (after a first
# `file:` install from scripts/pack-local.mjs), without reinstalling.
#   scripts/sync-into.sh /path/to/project
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
target="$1"
(cd "$root" && npm run build >/dev/null)
for pair in client:icebase server:icebase-server cli:icebase-cli; do
  dir="${pair%%:*}"; name="${pair##*:}"
  for d in "$target"/node_modules/.pnpm/@panth977+"$name"@file*/node_modules/@panth977/"$name"; do
    if [ -d "$d" ]; then rsync -a --delete "$root/packages/$dir/dist/" "$d/dist/"; echo "synced $name → $d"; fi
  done
done
