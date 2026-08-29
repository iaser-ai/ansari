# Builder thread — pir-70 (Issue #70: Gemini history fidelity)

## 2026-08-29 — Plan phase

Investigated both bugs. Key findings beyond the issue text:

- **Bug 1 mechanism confirmed in code** (`apps/api/lib/ai/gemini-client.ts:535-570`): the
  repetition-guard `break` exits the parts loop *before* later parts of the same chunk are
  processed, but `finalContent = candidate.content` (line 572) still runs after the inner
  break and stores the whole chunk. So `functionCall` parts after the break point land in
  `finalContent`/`rawPayload` but never in `toolCalls`. `streamRawPayload` then returns
  `finalContent` (allCallCount <= finalCallCount), keeping the orphan calls. The facilitator
  builds functionResponses only from collected toolCalls → count mismatch → Vertex 400 on
  the next call of the same request.

- **Bug 2**: the SSE routes (`threads/[id]/route.ts`, `threads/[id]/chat/route.ts`) do NOT
  pass `onMessage` to runFacilitator — they persist the aggregated streamed text themselves
  on the `done` event, which carries only `usage`. So `rawPayload` has no path to the DB at
  all, and `findMessagesByThread` → messageHistory mapping omits it too. Chosen design:
  carry `rawPayload` on the `done` FacilitatorStreamEvent (keeps persisted `content`
  byte-identical to today; onMessage path untouched), persist final-turn Content only.

- `mcp-complete` threads are one-shot (fresh thread per request, never re-read) — no
  rawPayload persistence needed there. `v1/chat/completions` is stateless.

- Poisoning hazard: once rawPayload IS persisted, a desynced payload (orphan functionCall)
  would 400 every subsequent turn of the thread forever. Plan includes a persist-time
  consistency guard (final turn with 0 collected tool calls must have 0 functionCall parts;
  else Sentry error + persist null) — this doubles as the instrumentation the issue asks for.

Plan written to codev/plans/70-gemini-history-fidelity-functi.md.
