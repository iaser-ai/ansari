# Build from the repository root: docker build -f apps/mcp/Dockerfile -t ansari-mcp .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE ./
COPY packages packages
COPY apps/mcp/package.json apps/mcp/
# Until SAGA 1.0.0-rc.1 is on the registry, the install resolves it from these private tarballs.
COPY apps/mcp/candidates apps/mcp/candidates
RUN pnpm install --strict-peer-dependencies --frozen-lockfile --filter ansari-mcp...
COPY apps/mcp apps/mcp
RUN pnpm mcp build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /repo/apps/mcp/dist ./dist
COPY --from=build /repo/apps/mcp/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
