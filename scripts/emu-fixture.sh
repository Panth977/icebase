#!/usr/bin/env bash
# Run the functions fixture on the official emulators (Java 21+), then the given test command.
#   scripts/emu-fixture.sh "npx vitest run test/functions.emu.test.ts"
set -euo pipefail
if ! java -version 2>&1 | grep -qE 'version "(2[1-9]|[3-9][0-9])'; then
  for j in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk /usr/lib/jvm/java-21-openjdk*; do
    if [ -x "$j/bin/java" ]; then export JAVA_HOME="$j"; export PATH="$j/bin:$PATH"; break; fi
  done
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$root/packages/icebase" && npx tsc -p tsconfig.build.json)
cd "$root/packages/icebase/test/fixtures/functions-app"
exec "$root/node_modules/.bin/firebase" emulators:exec --only functions,firestore,auth --project demo-icebase "cd $root/packages/icebase && ICEBASE_EMU=1 $*"
