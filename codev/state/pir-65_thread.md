# pir-65 — render streamed answer incrementally (removes #63's buffer-until-done)

## Phase: PLAN (iteration 1)

### Context gathered
- #63 is MERGED (closed). Transport + parser already shipped:
  - `lib/api/streaming.ts` — `streamChat()` opens ONE POST via `expo/fetch`, reads the
    streaming body, and delivers every typed event to an `onEvent` callback. XHR fallback was
    REMOVED; when `response.body` is absent it buffers the in-hand `.text()` (one-request
    property; `streaming.test.ts` asserts it — must preserve).
  - `lib/api/chat-stream.ts` — RN-free core: `consume()` folds SSE payloads into state, forwards
    each event to `onEvent`, loud-fails on error frame / non-JSON / non-string content;
    `assertComplete()` loud-fails on missing `done`. `ChatStreamEvent`: text | tool_call{name} |
    tool_result{tool,query,resultCount} | error | done.
  - `lib/api/sse.ts` — `\n\n`-framed, heartbeat-skipping, multi-chunk-tolerant parser.
- The GAP is RENDER, not transport (architect + issue both stress this).
- `app/chat/[id].tsx` today: `useSendMessage` mutation ignores the return; `ThinkingIndicator`
  (static "Searching the sources…") shows while `awaitingAnswer`; on success it invalidates the
  detail query and re-renders from the refetched thread. `ECHO_ID` reconciliation-by-identity
  pattern already exists for the user question (reuse this pattern for the streaming bubble).
- `useSendMessage` (`lib/api/hooks.ts:147`) calls `streamChat` WITHOUT `onEvent`.
- AMENDMENT (2026-08-28, in scope): carry `tool_call`/`tool_result` through the progress channel
  and replace the static indicator copy with live per-tool lines
  ("Searching hadith for \"patience\" — 12 results"; resultCount:0 → "no hadith found").
  Transient: shown only while awaiting, never persisted/replayed. NOT chips/citations.
- Hard constraints: all work inside `prototypes/ansari-expo` (OUTSIDE the 7-package turbo graph —
  confirmed `turbo ls` = 7 packages, prototype not listed); root `pnpm-lock.yaml` byte-identical;
  install with `pnpm install --ignore-workspace`; merge commit (never squash); never `git add -A`.
- Architect extra ask: manual account-switch smoke test (guest → register diff account → logout →
  login; no stale threads, no protected-screen flash) early in dev; report anomalies before building.

### Decisions
- Streaming answer rendered as a SYNTHETIC assistant message reconciled by identity (STREAM_ID),
  mirroring ECHO_ID — avoids the gap/duplicate flicker a header-swap would cause on `done`→refetch.
- Zero-text loud failure enforced in the parser core (`assertComplete`) via a `sawText` flag, so
  it is unit-testable without React and independent of whether the API emits an error frame.
- Trace copy logic extracted to a tiny pure helper so the "resultCount:0" wording is unit-tested.

Plan committed (9f62392) → plan-approval gate requested (2026-09-01T21:35Z). Architect read it
in full and forwarded to the human with an APPROVE recommendation via main. Awaiting relayed
human decision; do NOT run porch approve myself.

### Non-blocking note from architect for IMPLEMENT
- Synthetic streaming message uses `createdAt: ''`. This relies on #64's `timeAgo('')` guard.
  Keep a test asserting the synthetic bubble never renders a timestamp artifact. (Verify whether
  AnswerMessage even surfaces a timestamp — I did not see timeAgo/createdAt usage in it during
  plan investigation; check the render path incl. any parent/wrapper before asserting.)

Next (after approval): porch approve 65 plan-approval, then implement phase.

## Phase: IMPLEMENT (iteration 1)

Plan APPROVED by human (relayed by architect 2026-09-01T21:40Z). Ran porch approve, merged
origin/develop (picked up #107 + root `pnpm prototype` script + a README convenience block;
AnswerMessage/chat[id] untouched — reported to architect), advanced to implement.

Account-switch STATIC review done before building & reported to architect: applySession()
clears the query cache on every principal transition; AuthGate blocks render during
loading/redirect. Clean. Live click-through remains a reviewer step (I'm headless) — architect
will do it at dev-approval; keep the proved-by-me vs proved-by-reviewer split visible in notes.

Implemented (2 commits):
1. Plumbing: chat-stream sawText + zero-text guard in assertComplete; lib/chat-trace.ts
   (pure traceReducer/formatTraceLine); useSendMessage onEvent seam; barrel exports.
2. Render: app/chat/[id].tsx synthetic assistant bubble keyed per-turn (STREAM_KEY_PREFIX),
   identity reconciliation via keyOverrides on done (no flicker/gap/duplicate — memo suppresses
   the early-landed server answer while streaming, hand-off effect clears streamingText +
   sets override atomically). Live trace in ThinkingIndicator until first text frame. Partial
   kept on error. README rewritten. Tests added.

Verification: typecheck clean; `pnpm test` 89 passed (chat-trace 9, chat-stream 13, streaming 4,
AnswerMessage 6). No lint script in prototype. Hard constraints: turbo ls = 7 packages; root
pnpm-lock.yaml untouched; diff entirely under prototypes/ansari-expo + codev docs.

Design note for reviewer: trace is hidden once the first text frame lands (issue rule "keep the
indicator only until the first text frame"), so tool calls interleaved AFTER text begins don't
re-show the trace — documented simplification, fine for a prototype.

Pushed (90457b3), porch done → dev-approval gate. Messaged architect with proved-by-me vs
proved-by-reviewer split.

### dev-approval feedback iteration 1 (architect)
Architect message arrived TRUNCATED on my end — only saw the tail: "...ed search_ prefix,
GENERIC_TOOL path unchanged; unit-test the mapping incl. an unknown tool name. Commit, re-run
tests/tsc, message me the SHA — then I present the gate." Recovered intent by reading the
backend: facilitator tools are named search_quran / search_hadith / search_mawsuah /
search_tafsir_encyclopedia (apps/api/lib/tools/resilience.ts TOOL_LABELS; tool_call {name},
tool_result {tool,query,resultCount}). Without mapping the trace would read "Searching
search_hadith…".

Implemented displayTool() in lib/chat-trace.ts: strip 'search_' prefix + flatten underscores,
lowercase → bare inline labels (quran/hadith/mawsuah/tafsir encyclopedia). Unknown/unprefixed
id passes through; absent/empty keeps GENERIC_TOOL ('the sources'). Unit-tested incl. unknown id.
SHA 29a6909 pushed. typecheck clean; pnpm test 93 passed (+4). Flagged to architect that I used
BARE labels (not the backend's 'Quran search' TOOL_LABELS, which don't fit "Searching X for…"),
and that their message top was truncated — offered to switch wording if they meant the friendly
labels.

dev-approval GRANTED by human (relayed by architect 2026-09-01T22:15Z; architect verified
displayTool live against staging — "Searching quran for…"). Ran porch approve dev-approval.

## Phase: REVIEW (iteration 1)
- Wrote codev/reviews/65-prototypes-ansari-expo-render-.md (PR body): summary/problem+fix,
  files, commits, test results incl. negative + progressive test lists, hard-constraint check
  outputs, reviewer-vs-builder verification split, trace display-name fix note, things-to-look-at.
- Arch: no changes (client-only prototype render). Lessons: added COLD section to
  lessons-learned.md (issue #65: render-vs-transport; synthetic→persisted stable per-turn key;
  pre-validation onEvent artifact) + synced hot-tier map in lessons-critical.md.
- Committed (0a9cbc9), pushed. Opened PR #108 --base develop (Fixes #65 present).
  porch done --pr 108 recorded; porch done 65 → checks passed → 3-way consult tasks.
- Running consult -m gemini/codex/claude (impl) in background (task b4odkiqoi). Single advisory
  pass (max_iterations 1); verdicts surface to human at pr gate.

Consults done: Gemini APPROVE, Codex COMMENT, Claude REQUEST_CHANGES.
- Claude REQUEST_CHANGES (blocking, doc-only, VALID — real miss): lib/api/streaming.ts still had
  #63's buffer-until-done 'PROTOTYPE LIMITATION' docstring (L19/L28-32/L86) contradicting the new
  README + plan's 'fix everywhere'. FIXED: rewrote docstring + onEvent comment + fallback comment.
- Codex COMMENT (VALID): traceReducer matched earliest-pending regardless of tool. FIXED: match by
  tool w/ earliest-pending fallback; added out-of-order + name-mismatch tests.
- 3 non-blocking Claude notes captured in review Things-to-Look-At (budget-skipped tool -> 'no X
  found' w/ no backend skip signal; per-delta re-parse -> added iOS long-answer jank check;
  sentAtCount ?? 0 fallback).
Fixes in 0beebf5 (pushed, PR #108 body refreshed). typecheck clean; pnpm test 95 passed.
Wrote rebuttal (65-review-iter1-rebuttals.md), porch done -> pr gate PENDING.
Messaged architect leading with the REQUEST_CHANGES.

## Phase: PR GATE (pending)
Holding. main runs integration review; human merges on GitHub. Do NOT run porch approve myself.
On approval relay: porch approve 65 pr --a-human-explicitly-approved-this, then porch done
--merged 108, then enter verify phase / notify architect complete.
