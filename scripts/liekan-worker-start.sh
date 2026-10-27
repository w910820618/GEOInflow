#!/bin/sh
# Starts a background worker after the app has finished migrations and queue setup.
# Usage: sh scripts/liekan-worker-start.sh dist/liekan-worker.mjs
set -eu
export PATH="$PWD/node_modules/.bin:$PATH"
node scripts/liekan-wait-ready.mjs
exec node "$@"
