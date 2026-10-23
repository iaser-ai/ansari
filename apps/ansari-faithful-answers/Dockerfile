FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
# pnpm-workspace.yaml carries the adapter override; the committed lockfile fixes every other version, including the exact
# public SAGA release from the npm registry. No credentials or local packages are needed.
RUN pnpm install --strict-peer-dependencies --frozen-lockfile && pnpm build
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
