# pir-128 — thread-typed follow-up isn't echoed until post-done refetch

## PLAN phase (2026-09-09)

Investigated `prototypes/ansari-expo/lib/chat-reconcile.ts` +
`app/chat/[id].tsx`. Confirmed the issue's root cause: `reconcileThread` only
synthesises the carried-in `q` (ECHO_ID); a thread-typed follow-up sent via
`send()` is never handed to the reconciler, so it appears only on the
post-`onSuccess` refetch — after the answer has been streaming against an empty
slot.

Plan: generalise the echo. New `pendingFollowUp` / `followUpKey` inputs to the
reconciler, a synthetic user row reconciled by `content` (last match, skip
ECHO_ID), and a `landedFollowUp` result that the screen's `done` hand-off effect
uses to give the row a durable key override — exactly parallel to how
`landedAnswer` drives the assistant row. `landedAnswer` detection is untouched
(reads `serverMessages` only; the synthetic row is output-list-only).

Plan written to `codev/plans/128-prototypes-ansari-expo-thread-.md`, committed,
awaiting `plan-approval`.

## Rebase check (2026-09-23)

Architect flagged: #158/PR #159 rewrote parts of `app/chat/[id].tsx` since the
plan was drafted (Sep 9) — needed to confirm the plan still holds before
plan-approval.

- Merged `origin/develop` (through PR #162 / spec 66) — clean, no conflicts.
- `lib/chat-reconcile.ts`: **untouched** by #158/#159 (that work is
  facilitator/message-schema — citable documents — unrelated to the
  reconciler).
- `app/chat/[id].tsx`: gained `rawStreamText` (raw model text, cleaned via
  `stripStreamingCitations` into `streamingText`) and a `GeneratingMark`
  footer state (PR #159). Both are siblings to reset alongside
  `streamingText`/`trace` in `send()` and the `done` hand-off effect — they
  don't touch the input construction this plan modifies, and the newer
  `GeneratingMark` / `AnswerMessage.generating` prop key off
  `streamKey.current`/`streamingText`, not the message list, so they're
  unaffected by adding a follow-up row.
- Conclusion: **no redesign needed.** Updated the plan's file:line references
  (`send()` now 308-328, hand-off effect 408-420, `carriedInWait` 477, etc.)
  and called out the `rawStreamText` touchpoint explicitly. Approach
  (`pendingFollowUp` / `followUpKey` / `landedFollowUp`, mirroring
  `ECHO_ID`/`landedAnswer`) is unchanged.

Revised plan committed (`f947eb8`, on top of merge `4b43787`), pushed. Back to
awaiting `plan-approval`.
