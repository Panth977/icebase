#!/usr/bin/env bash
# Run a command against the official Firebase emulators (they need Java 21+).
#   scripts/emu.sh firestore,auth "npx vitest run test/firestore.emu.test.ts"
set -euo pipefail
only="$1"; shift
if ! java -version 2>&1 | grep -qE 'version "(2[1-9]|[3-9][0-9])'; then
  for j in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk /usr/lib/jvm/java-21-openjdk*; do
    if [ -x "$j/bin/java" ]; then export JAVA_HOME="$j"; export PATH="$j/bin:$PATH"; break; fi
  done
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
exec "$root/node_modules/.bin/firebase" emulators:exec --only "$only" --project demo-icebase "$*"
