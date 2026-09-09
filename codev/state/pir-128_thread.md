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
