# WhatsApp service (apps/whatsapp, issue #358) image. Build context is the REPO
# ROOT (the pnpm workspace needs the root lockfile):
#   docker build -f apps/whatsapp/Dockerfile .
#
# Same shape as apps/auth/Dockerfile, on purpose: single stage, the install CI
# verifies, real entry point. tsdown bundles our own code into dist/index.mjs and
# leaves express, cors, zod, dotenv and @sentry/node as imports, so the runtime
# needs this install's node_modules. Call node directly, not `pnpm`: corepack
# cached pnpm for root at build time, so as `node` it would try to download pnpm
# at run time.
FROM node:22-slim

# packageManager in the root package.json pins the exact pnpm version.
RUN corepack enable

WORKDIR /repo

# Workspace manifests first so the dependency layer caches independently of
# source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/whatsapp/package.json apps/whatsapp/
# The shared config packages must be present BEFORE install (workspace:* links),
# and tsconfig extends the shared base at build time.
COPY packages packages
RUN pnpm install --frozen-lockfile --filter ansari-whatsapp...

COPY apps/whatsapp apps/whatsapp

# tsdown needs no env: nothing reads the environment at import.
RUN pnpm --filter ansari-whatsapp build

ENV NODE_ENV=production

# COPY keeps the build context's file modes; a checkout with a restrictive umask
# (files 0600) would leave the copied sources unreadable to `node` below. Open
# them for reading. node_modules is not walked (pnpm's entries there are symlinks).
RUN chmod -R a+rX /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml \
    /repo/packages /repo/apps/whatsapp

WORKDIR /repo/apps/whatsapp

# Run as the image's unprivileged `node` user. Nothing is written at runtime.
USER node

# One listener, PORT. Railway sets PORT itself (see railway.toml); 3200 is the
# local default.
EXPOSE 3200
CMD ["node", "dist/index.mjs"]
