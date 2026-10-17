# Better Auth service (apps/auth, spec 300) image. Build context is the REPO
# ROOT (the pnpm workspace needs the root lockfile):
#   docker build -f apps/auth/Dockerfile .
#
# Same shape as apps/api/Dockerfile, on purpose: single stage, the install CI
# verifies, real environment variables injected by Railway at RUNTIME and none
# baked in. The full install is kept (not prod-pruned) because the two
# operator scripts can run in this image, from /repo/apps/auth:
#   ./node_modules/.bin/tsx scripts/grant-admin.ts …   (and scripts/ban-user.ts)
# They need tsx and the raw-TS @ansari/auth workspace link, and need no psql;
# they also run from a checkout with the auth DATABASE_URL. The cutover itself
# (copy, audits, migrations) runs on the owner's machine over Tailscale, not
# here (spec 300 amendment H-8), so this is the service image only: no
# Postgres client, no migration SQL. Call tsx directly,
# not `pnpm exec`: corepack cached pnpm for root at build time, so as `node`
# it would try to download pnpm at run time.

# Debian-based (not alpine): bcrypt's prebuilt native binaries target glibc;
# musl would force a node-gyp toolchain into the image. bcrypt stays an
# external import of node_modules (tsdown neverBundle), so the runtime needs
# this install's node_modules/bcrypt.
FROM node:22-slim

# packageManager in the root package.json pins the exact pnpm version.
RUN corepack enable

WORKDIR /repo

# Workspace manifests first so the dependency layer caches independently of
# source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/auth/package.json apps/auth/
# Shared workspace packages must be present BEFORE install (workspace:* links),
# and their CONTENTS are needed at build time: tsdown bundles @ansari/auth and
# @ansari/types into dist, and tsconfig extends the shared base.
COPY packages packages
RUN pnpm install --frozen-lockfile --filter ansari-auth...

COPY apps/auth apps/auth

# tsdown needs no env: nothing reads the environment at import.
RUN pnpm --filter ansari-auth build

ENV NODE_ENV=production

# COPY keeps the build context's file modes. A checkout with a restrictive
# umask (files 0600) would leave every copied source unreadable to `node`
# below: the service still boots (it reads only dist/ and node_modules/,
# which this build created), but grant-admin.ts and ban-user.ts fail with EACCES.
# Open the copied sources for reading; node_modules is not walked (pnpm's
# entries there are symlinks), so this layer stays small.
RUN chmod -R a+rX /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml \
    /repo/packages /repo/apps/auth

WORKDIR /repo/apps/auth

# Run as the image's unprivileged `node` user. Nothing is written at runtime.
USER node

# One listener, PORT (3100), behind the public domain. There is no internal
# listener (owner amendment 2026-10-17). See railway.toml.
EXPOSE 3100
CMD ["node", "dist/index.mjs"]
