# Plan 314: iteration 1 rebuttals

All points are accepted. The changes are in commit "[Spec 314] Plan with multi-agent review".

## Codex (REQUEST_CHANGES)

1. **apps/auth has no direct `@ansari/types` dependency.**
   Accepted.
   - apps/auth reaches the rule through `@ansari/auth`.
   - `packages/auth/src/index.ts` re-exports `isMcpClientId` and `MCP_CLIENT_ID_PATTERN`. This follows the existing `CLIENT_HEADER` re-export.
   - `apps/auth/package.json` is unchanged.

2. **`packages/types` has no test runner.**
   Accepted.
   - No runner is added.
   - The pattern is tested in `packages/auth/tests/unit/helpers.test.ts`, which already tests `@ansari/types/attribution`.
   - It is tested again from apps/api in Phase 3.

3. **Phase 4 must stub `fetch`, not mock `verifyServiceKey`.**
   Accepted.
   - The new route suite stubs global `fetch` at the apps/auth boundary, so the real `verifyServiceKey` and `authServiceFetch` run.
   - The shared helper for the existing suites also stubs `fetch`. It covers the verify URL only and passes every other request through. It sets the `AUTH_*` env with `vi.stubEnv` when a suite has none.

## Gemini (APPROVE, with notes)

- **The `ansari-mcp` call sites in `service-keys.test.ts` (about lines 626 and 693):** they gain a valid `--client-id` in Phase 1.
- **The `cutover-docs.test.ts` source scan of `alerts.ts`:**
  - `ExchangeAlert` keeps its six WhatsApp kinds, immediately above `KeyRefusalCode`.
  - The MCP union is a separate type, declared after them.
  - The runbook's `ansari-mcp` material goes under its own `##` heading, so `section('Limits')` and `section('Alerts')` still match only the WhatsApp tables.
- **Sentry `client` tag parity:** on a valid key, the gate sets `Sentry.setTag('client', clientId)`.
