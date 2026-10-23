# 301: Implementation plan

Protocol: ASPIR; final upstream merge remains a maintainer decision.

```json
{"phases":[{"id":"transfer","title":"Import application and workspace integration","status":"in-progress"},{"id":"qualification","title":"Qualify destination revision and prepare contribution PR","status":"pending"}]}
```

## Transfer

Copy only application source, assets, tests and build scripts from qualified source tag `ansari-public-sdk-qualified-2026-10-21`. Exclude operational records and private deployment adapters. Use the existing `apps/*` workspace enrollment, preserve root overrides and add the supported Markdown adapter pin. Use the TypeScript catalog, one root lockfile and package-local Turbo runtime environment declarations. Keep the new listener opt-in for local development. Document package-relative Docker context and add a public-only standalone CI job.

Verify dependency resolution, content/license audit, build/typecheck, server/browser suite and no-network Docker smoke. Consult independently before committing.

## Qualification

Push the reviewed contribution branch to the contributor fork. Build the exact commit using public packages and deploy to the existing authorized DEV target. Preserve the private operational adapter outside this repository. Capture one representative complete answer/card in each host and actual Alexa cached resource identity. Record failures and retry recovery accurately. Create the upstream PR only after validation; do not merge it.

Use the SAGA CLI’s qualified Hono starter as a separate reference. Mount the upstream stateless MCP request handler on Hono with official Host/Origin middleware. Extract startup-only view preparation, remove session/replay and per-call lifetime workarounds, and qualify modern and older-host traffic plus the existing UI/container path.
