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
- `46966b1` (rewritten, see below) [PIR #128] Generalise the echo: reconciler learns pendingFollowUp/followUpKey
- `338456f` [PIR #128] Wire pendingFollowUp into the chat screen
- `55abc6d` [PIR #128] Thread log: staging-500 blocker root cause + resolution, rebase onto develop
- `12b6fbd` [PIR #128] Fix: bind follow-up match to landedFollowUp identity, not unbounded content scan
- (merge commits pulling `origin/develop` forward as the base moved twice during review)

**History rewritten once, post-3-way-consult** (`git rebase --onto` +
`--rebase-merges`, then `push --force-with-lease`): gitleaks flags per-commit,
not per-final-diff, so the `chat-reconcile.test.ts:7` false positive (see
"Things to Look At") had to be fixed by amending the commit that introduced
it (`46966b1`), not by adding a later rename commit on top — a later commit
leaves the flagged line sitting in `46966b1`'s own patch, still caught by a
scan over `origin/develop..HEAD`. The resulting tree is byte-identical to the
pre-rewrite tip (verified via `git diff <old-tip> HEAD`); only the commit
`46966b1` (now: "Generalise the echo…") and everything downstream carry new
SHAs.

## Test Results

- `vitest run`: ✓ pass (251 tests, 14 in `chat-reconcile.test.ts` — 7 for the
  follow-up echo, including the consult-driven regression test below)
- `tsc --noEmit`: ✓ pass
- `gitleaks detect` (local, matching CI's `.github/scripts/gitleaks-scan.sh`
  exactly): ✓ clean, verified before and after the force-push
- Manual verification (Omar, `dev-approval`): confirmed working against
  staging at `localhost:8081` (**web only** — see "Things to Look At") — a
  thread-typed follow-up now appears immediately above the thinking line /
  streaming answer, with no gap and no duplicate/re-animation at `done`.

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

- **3-way consult REQUEST_CHANGES, FIXED (codex + claude, both HIGH
  confidence)**: the original follow-up match (`chat-reconcile.ts:140-148`,
  pre-fix) scanned the whole rendered list backward for the last user row
  with matching content, with no lower bound — unlike `landedFollowUp`'s own
  scan, which correctly starts at `sentAtCount`. A reader repeating earlier
  text as a follow-up (e.g. asking "tell me more" twice) would claim that
  OLD row instead of appending a new one, reproducing #128's exact symptom
  for that input, and re-key a historical row so it reads as new content and
  re-animates. **Fix** (`12b6fbd`): match by `landedFollowUp`'s identity
  (itself bound to `sentAtCount`) instead of an unbounded content scan.
  **Regression test** added: a prior user message with the same text as
  `pendingFollowUp`, pre-refetch — asserts the old row keeps its own id and a
  new synthetic row is appended. This was **not** independently re-reviewed
  (PIR's consultation is single-pass) — please read `chat-reconcile.ts:135-165`
  and the new test directly at the `pr` gate rather than relying on the
  fixed-once verdict.
- **Consult non-blocking notes (not fixed, by design)**: (1) `pendingFollowUp`
  only clears inside `if (streamingText && landedAnswer)`
  (`app/chat/[id].tsx:432`) — a turn landing with empty streamed text (a
  tool-only turn, a refusal) leaves it set until the next send; harmless
  because the content match still prevents a duplicate row, but noted as an
  asymmetry with `streamingText`'s own reset. (2) Retry (`send(failedQuestion)`)
  bumps `turnSeq`, so the question bubble gets a fresh `followUpKey` and
  re-animates — arguably correct (it *is* a new turn), flagged as a judgment
  call rather than a bug.
- **Gitleaks false positive, FIXED**: `chat-reconcile.test.ts:7`'s
  `FOLLOWUP_KEY` constant tripped the `generic-api-key` rule (name contains
  "KEY" + the literal's entropy) — `STREAM_KEY`, same shape, predates this PR
  so wasn't rescanned. Renamed to `FOLLOWUP_ID`; verified clean locally with
  the same `gitleaks detect` invocation CI uses, and green on the PR's actual
  gitleaks check post-push.
- **Manual verification was web only.** The plan's Test Plan calls for web +
  iOS because `FlatList` virtualization and the `drawn`/`keyFor`
  mount-animation gating (the exact area this PR touches) differ by platform.
  Only `localhost:8081` (Expo web) was exercised at `dev-approval`, due to the
  staging outage below eating the available review window. Recommend an iOS
  pass before/shortly after merge — nothing in the reconciler is
  platform-specific, but the animation-gate interaction has not been observed
  natively.
- **The "last match, skip `ECHO_ID`" rule**: superseded by the identity-bound
  fix above — kept only for the `q === pendingFollowUp` case, still covered
  by its original dedicated test.
- **The `done` hand-off effect** (`app/chat/[id].tsx:432-451`) performs two
  key remaps in one `setKeyOverrides` call — worth a close read to confirm
  the functional-update shape is right (it mirrors the existing `landedAnswer`
  remap exactly, guarded on `landedFollowUp`'s own truthiness).
- **Mid-review environment blocker, unrelated to this diff**: staging's
  `GET /api/v2/threads/{id}` was 500ing for every thread (root-caused via raw
  `curl`, zero frontend involved) due to issue #66/spec 66's `messages.documents`
  column being queried before its migration had landed on the staging DB.
  Resolved upstream by #165's revert + spec 168's replacement design (PR #180,
  merged to `develop`) — no action was needed in this PR, and this branch was
  rebased onto that fix before re-testing. Noted here only because it cost
  real review time (and the remaining web-only test window above) and is
  worth knowing about if a similar "staging 500s on everything" report comes
  in again.

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
