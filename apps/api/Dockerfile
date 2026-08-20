# Backend (Next.js API) image. Build context is the REPO ROOT (pnpm
# workspace needs the root lockfile):
#   docker build -f apps/api/Dockerfile .
#
# Deliberately single-stage and un-clever: it mirrors exactly what CI
# verifies (root pnpm install, build with the committed dummy .env.ci,
# next start). Real environment variables are injected by Railway at
# RUNTIME — none are baked into the image. Optimize (standalone output,
# prod-pruned deps) only after this is proven on Railway.

# Debian-based (not alpine): bcrypt's prebuilt native binaries target
# glibc; musl would force a node-gyp toolchain into the image.
FROM node:22-slim

# packageManager in the root package.json pins the exact pnpm version.
RUN corepack enable

WORKDIR /repo

# Workspace manifests first so the dependency layer caches independently
# of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter ansari-api

COPY apps/api apps/api

# next build requires a validly-shaped env (lib/config.ts Zod-validates on
# first config access). The committed .env.ci provides deliberately fake values — the
# same contract CI builds with. Nothing here reaches the runtime env.
RUN set -a && . ./apps/api/.env.ci && set +a && pnpm --filter ansari-api build

ENV NODE_ENV=production
WORKDIR /repo/apps/api

# next start honours Railway's PORT env var (default 3000 locally).
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
