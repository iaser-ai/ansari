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

## Implement phase (2026-09-23)

Plan approved. Implemented per plan: `pendingFollowUp`/`followUpKey` in
`chat-reconcile.ts` (+ `landedFollowUp`), wired into `app/chat/[id].tsx`'s
`send()` and the `done` hand-off effect. 6 new unit tests
(`chat-reconcile.test.ts`), including the dedicated "`landedAnswer` unaffected
by `pendingFollowUp`" test the plan called for. `vitest run` 250/250,
`tsc --noEmit` clean. Two commits: `46966b1` (reconciler+tests), `338456f`
(screen wiring). Porch `build`/`tests` gate checks needed `apps/api`'s
documented CI dummy env (`apps/api/.env.ci`) since this worktree has no real
`apps/api/.env` — same as the main checkout, unrelated to this diff. At
`dev-approval`, notified architect.

## Manual-test blocker: staging 500s (2026-09-23–25), NOT caused by this diff

Started this worktree's Expo web dev server (`localhost:8081`, `.env.local` →
`https://api-staging.askansari.ai`) for Omar to test. Every thread failed to
load ("This conversation didn't load."), reproduced even in incognito.

Root-caused via raw `curl` against staging (zero frontend involved):
`POST /register` and `POST /threads` succeeded, but `GET /threads/{id}`
500'd — `{"detail":"Failed to get thread"}` — for every thread, including a
brand-new empty one. Traced to `apps/api/src/app/api/v2/threads/[id]/route.ts`
selecting `messages.documents` (issue #66/spec 66/PR#162, merged to `develop`)
while its migration (`drizzle/0009_documents.sql`) looked unapplied on the
staging DB — DB behind the deployed code. Confirmed shared-infra (same
failure via plain `curl`, unrelated to any branch/frontend). Flagged to
architect as a blocker with root cause + two remediation options (apply
migration vs. local backend); recommended applying the migration as best
practice over standing up a local `apps/api` (which would need non-self-serve
`KALEMAT_API_KEY`/`USUL_API_TOKEN`/Gemini keys and wouldn't fix the shared
issue for anyone else).

**Resolution (architect, 2026-09-25):** #66's `messages.documents` design was
reverted (issue #165) and replaced by spec 168 (dedicated `/documents`
endpoints, PR #180) — no SQL needed, staging confirmed healthy as of
`c7737db`. Re-verified myself via the same raw-`curl` probe:
`GET /threads/{id}` now returns 200.

Merged `origin/develop` (through PR #186 / spec-168-latency-waiver) — clean,
no conflicts. Confirmed `app/chat/[id].tsx` and `chat-reconcile.ts` unchanged
by any of develop's new commits (merge-base for those two files is still
`1551edd`, same as before) — bugfix-164/182 and spec 168 touched other files
entirely (legacy-web, apps/api). Neither of my two files references
`documents`/citations. Re-ran `vitest run` (250/250) and `tsc --noEmit`
(clean) post-merge. Dev server at `localhost:8081` still up, unaffected
(prototype code untouched by the merge). Back to Omar for manual
dev-approval testing.
