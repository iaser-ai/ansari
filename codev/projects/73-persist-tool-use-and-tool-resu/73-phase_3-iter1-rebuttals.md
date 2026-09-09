# Spec 73 — Phase 3 Iteration 1 Rebuttal

Verdicts: gemini APPROVE, claude APPROVE, codex REQUEST_CHANGES.

## Codex — `toolCalls ?? null` could persist `[]`

**Accepted, fixed.** The facilitator never emits an empty array today
(`collectedToolCalls()` returns `undefined` for zero records), but Phase 2's
event contract says "absent/empty", so the persist sites must not depend on
that. Added `toolCallsOrNull()` in `db/schema/messages.ts` — a pure helper
(absent AND empty → `null`) — and switched all three sites to it. Placing it in
the schema module rather than `lib/db/threads` means no existing factory mock
of the threads module needs another export. Regression cases added for all
three sites (empty array on a success turn → `NULL`) plus the orphan side
(empty array on an error turn → no orphan row; `persistOrphanToolCalls`
already short-circuits on length 0).

## Claude (non-blocking) — Sentry signal on orphan-write failure

**Accepted, done.** `persistOrphanToolCalls` now also emits a warning-level
`Sentry.captureMessage` with the same non-PII summary (`threadId`, `reason`,
`recordCount`, `{name, code}`). A silently lost orphan row is precisely the
undercount this feature exists to remove.

## Claude (non-blocking) — post-`close()` async work on streaming routes

**Accepted as documentation.** The orphan write on the SSE/raw-text routes
runs after `safeClose()` inside the `ReadableStream.start` closure, i.e. after
the response is complete from the client's perspective. This is the same
position as nothing-else-today — but it is new post-close DB work, and it
relies on the runtime not tearing down the request context on close (true for
the Node runtime on Railway, where the assistant `createMessage` on the `done`
path already runs before close but the heartbeat teardown in `finally` runs
after). Noted for the review doc's operational section; no code change.
