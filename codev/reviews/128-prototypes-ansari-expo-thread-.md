# PIR Review: Echo a thread-typed follow-up immediately (generalise ECHO_ID)

Fixes #128

## Summary

In `prototypes/ansari-expo`, a follow-up typed into an open thread wasn't
rendered until the post-`done` refetch landed — so incremental streaming (#124)
made the answer visibly write itself onto the page with no question above it
for several seconds. This generalises the reconciler's existing carried-in-
question mechanism (`ECHO_ID`) to a second synthetic row: `chat-reconcile.ts`
now accepts `pendingFollowUp`/`followUpKey`, renders the follow-up the instant
it's sent, reconciles it against the server's persisted copy by content once
the refetch delivers it, and returns `landedFollowUp` so the screen's `done`
hand-off gives the row the same durable key treatment as the answer bubble.

## Files Changed

(vs merge-base `eea4002`, develop)

- `prototypes/ansari-expo/lib/chat-reconcile.ts` (+79 / -6) — `pendingFollowUp`
  / `followUpKey` inputs, the synthetic/reconciled follow-up row (matched from
  the end, skipping `ECHO_ID`), `landedFollowUp` in the result
- `prototypes/ansari-expo/app/chat/[id].tsx` (+43 / -4) — `pendingFollowUp`
  state + `followUpKey` ref, set in `send()` (skipped for the carried-in `q`),
  wired into `reconcileThread(...)`, and the `done` hand-off effect extended
  to remap `landedFollowUp`'s key and clear `pendingFollowUp`
- `prototypes/ansari-expo/lib/chat-reconcile.test.ts` (+136 / -0) — 6 new
  cases covering the pre-refetch synthetic row, post-refetch reconciliation,
  `landedFollowUp`, `landedAnswer` non-interference, and the `q ===
  pendingFollowUp` identical-text edge case

No `apps/` or `packages/` changes — prototype-side only.

## Commits

- `89bbdac` [PIR #128] Plan draft
- `f947eb8` [PIR #128] Plan revised: rebase onto develop, confirm approach against #158/#159 changes
- `46966b1` [PIR #128] Generalise the echo: reconciler learns pendingFollowUp/followUpKey
- `338456f` [PIR #128] Wire pendingFollowUp into the chat screen
- `55abc6d` [PIR #128] Thread log: staging-500 blocker root cause + resolution, rebase onto develop
- (2 merge commits pulling `origin/develop` forward as the base moved during review)

## Test Results

- `vitest run`: ✓ pass (250 tests, 13 new/updated in `chat-reconcile.test.ts`
  — 6 new follow-up cases + `pendingFollowUp`/`followUpKey` added to the
  shared `base` fixture)
- `tsc --noEmit`: ✓ pass
- Manual verification (Omar, `dev-approval`): confirmed working against
  staging at `localhost:8081` — a thread-typed follow-up now appears
  immediately above the thinking line / streaming answer, with no gap and no
  duplicate/re-animation at `done`.

## Architecture Updates

No `arch.md`/`arch-critical.md` changes. This generalises an already-
documented mechanism (the `ECHO_ID` / per-turn stable-key hand-off from issue
#65, `lessons-learned.md`) to a second synthetic row — it doesn't introduce a
new module boundary or system-shape fact, so nothing new belongs in either
tier.

## Lessons Learned Updates

Added a bullet to the existing `## Incremental streaming render — prototype
(issue #65)` section in `codev/resources/lessons-learned.md` (cold tier —
this is a spec-narrow extension of that section's existing pattern, not a new
cross-cutting rule): a second synthetic row that shares the hand-off trick
must get its OWN durable `keyOverrides` entry in the same effect, or clearing
the state that drove its input-side reconciliation makes it revert to its raw
id and re-animate; and the detection that decides *when* the hand-off fires
must keep reading only the source data (never the reconciler's output list),
so a second synthetic row added to the output can't quietly perturb it.

## Things to Look At During PR Review

- **The "last match, skip `ECHO_ID`" rule** (`chat-reconcile.ts:140-165`):
  handles the case where the carried-in `q` and a later follow-up are
  identical text — `q` never clears once the thread is open, so this is a
  real (if narrow) scenario, not a hypothetical. Covered by a dedicated test.
- **The `done` hand-off effect** (`app/chat/[id].tsx:432-451`) now performs
  two key remaps in one `setKeyOverrides` call — worth a close read to
  confirm the functional-update shape is right (it mirrors the existing
  `landedAnswer` remap exactly, just guarded on `landedFollowUp`'s own
  truthiness).
- **Mid-review environment blocker, unrelated to this diff**: staging's
  `GET /api/v2/threads/{id}` was 500ing for every thread (root-caused via raw
  `curl`, zero frontend involved) due to issue #66/spec 66's `messages.documents`
  column being queried before its migration had landed on the staging DB.
  Resolved upstream by #165's revert + spec 168's replacement design (PR #180,
  merged to `develop`) — no action was needed in this PR, and this branch was
  rebased onto that fix before re-testing. Noted here only because it
  cost real review time and is worth knowing about if a similar "staging 500s
  on everything" report comes in again.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-128` → **Review
  Diff** (auto-detects `develop` as the base)
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-128`
- **What to verify** (from the plan's Test Plan):
  - Open an existing thread, type a follow-up: it appears immediately as a
    user bubble at the foot of the thread, before any thinking/streaming UI
  - After the answer completes: exactly one question bubble, no
    duplicate/re-animation at `done`
  - Carried-in path (home screen `?q=`) unchanged
  - Send failure: kill the network mid-follow-up — the question bubble stays
    above the "Answer not delivered" notice; Retry re-runs the turn
  - Scroll up through a long thread after several follow-ups — no turn
    re-animates as it scrolls back into view

## Flaky Tests

None.
