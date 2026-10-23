#!/usr/bin/env bash
# Standalone rehearsal on the public npm packages. Requires Node, pnpm and Docker; no credentials. Every dependency,
# including the exact SAGA release, comes from the public npm registry with a fresh store and an empty npm configuration.
set -euo pipefail
app_root=$(cd "$(dirname "$0")/.." && pwd)
verify_root=$(mktemp -d)
container=""
image="ansari-public-ci:$(date +%s)-$$"
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$verify_root"
}
trap cleanup EXIT
mkdir -p "$verify_root/apps/ansari-faithful-answers"
# Copy only application files. Do not carry an installation, lockfile or credentials.
bash "$app_root/scripts/copy-app-source.sh" "$app_root" "$verify_root/apps/ansari-faithful-answers"
app="$verify_root/apps/ansari-faithful-answers"
# A destination workspace reads only its root file, so the standalone entry is not carried into the install.
rm "$app/pnpm-workspace.yaml"
printf '{"private":true,"packageManager":"pnpm@10.33.0"}\n' > "$verify_root/package.json"
# Exercise the documented destination-root placement of the adapter override.
printf "packages:\n  - apps/*\noverrides:\n  '@a2ui/markdown-it': '0.2.1'\n" > "$verify_root/pnpm-workspace.yaml"
: > "$verify_root/npm-user.conf"
: > "$verify_root/npm-global.conf"
export NPM_CONFIG_USERCONFIG="$verify_root/npm-user.conf"
export NPM_CONFIG_GLOBALCONFIG="$verify_root/npm-global.conf"
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
unset NODE_AUTH_TOKEN NPM_TOKEN || true
cd "$verify_root"
pnpm install --strict-peer-dependencies --store-dir "$verify_root/store"
cd "$app"
# The release gate reads the committed application lockfile and checks the registry, so it runs on the committed folder
# (the isolated copy deliberately carries no lockfile).
node "$app_root/scripts/check-release.mjs" --target beta
pnpm exec playwright install chromium
pnpm verify
# The normal standalone Docker context is the application folder itself: it needs its own workspace
# file (adapter override) and its lockfile again, as committed.
cp "$app_root/pnpm-workspace.yaml" "$app/pnpm-workspace.yaml"
cp "$app_root/pnpm-lock.yaml" "$app/pnpm-lock.yaml"
docker build --no-cache -t "$image" "$app"
container=$(docker run -d --network none -e ANSARI_RELEASE=ci-public-smoke -e ANSARI_API_BASE_URL=http://127.0.0.1:4010 -e MCP_RESPONSE_MODE=json "$image")
[[ $(docker inspect "$container" --format '{{len .Mounts}}') == 0 ]]
docker exec -i "$container" node --input-type=module < "$app/scripts/docker-smoke.mjs"
docker stop --time 10 "$container" >/dev/null
[[ $(docker inspect "$container" --format '{{.State.ExitCode}}') == 0 ]]
echo 'Public-package standalone tests and Docker smoke passed.'
