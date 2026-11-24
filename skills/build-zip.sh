#!/bin/sh
# Builds ansari-skill.zip from skills/ansari, with the layout the old
# ansari-project/ansari-skill release asset had: ansari/ and ansari/SKILL.md.
# Usage: sh skills/build-zip.sh [output path]   (default: ./ansari-skill.zip)
set -eu
out="${1:-ansari-skill.zip}"
case "$out" in /*) ;; *) out="$(pwd)/$out" ;; esac
rm -f "$out"
cd "$(dirname "$0")"
zip -q -r -X "$out" ansari -x '*.DS_Store'
echo "wrote $out"
