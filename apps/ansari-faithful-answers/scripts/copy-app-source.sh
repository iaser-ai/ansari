#!/usr/bin/env bash
# Copy only application source from a source folder into a destination folder (used by verify-standalone.sh).
# Usage: copy-app-source.sh SOURCE_DIR DEST_DIR
# Excluded: installations, build output, Wrangler local state, lockfile and credentials (.env*, .dev.vars*, .npmrc).
set -euo pipefail
src=$1
dest=$2
mkdir -p "$dest"
tar -C "$src" \
  --exclude=node_modules --exclude=dist --exclude=dist-worker --exclude=.wrangler --exclude=.git \
  --exclude='.env*' --exclude='.dev.vars*' --exclude=.npmrc \
  --exclude=pnpm-lock.yaml --exclude=test-results --exclude=playwright-report \
  -cf - . | tar -C "$dest" -xf -
