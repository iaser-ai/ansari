#!/usr/bin/env sh
# Run cucumber-js on Node 22 (Cucumber 13 does not support Node 23, and the repo
# pins 22 in .nvmrc). Uses $BDD_NODE if set, else Homebrew's node@22 when
# present, else whatever `node` is on PATH.
set -e
cd "$(dirname "$0")/.."
NODE="${BDD_NODE:-}"
if [ -z "$NODE" ] && [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  NODE=/opt/homebrew/opt/node@22/bin/node
fi
NODE="${NODE:-node}"
exec "$NODE" --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js "$@"
