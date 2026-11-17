# pir-400 thread

## Plan (2026-11-16)

Issue #400: thread history is unbounded. Scope fixed by the owner's second comment on the issue:
warn at 150,000 tokens, block at 200,000, plain message when a prompt is too large for a model,
all four entry points, no new route, status or response shape. I read the issue comments before
starting; no Railway variables, credentials or production logs were read.

Plan: `codev/plans/400-thread-history-is-unbounded-lo.md`.

### What I found that changes the design

- The stored `input_tokens` cannot be the measure. It is summed over every model call of a turn
  (`agent.ts:532-545`), so a tool-heavy answer stores several times the thread's size. The plan
  proposes an estimate from the text about to be sent (UTF-8 bytes / 4) for every thread. This
  departs from the signal the issue suggests and is flagged for the plan gate.
- The web app and WhatsApp both use `POST /threads/{id}/chat`; the legacy mobile app uses
  `POST /threads/{id}`. The web app and WhatsApp never show an error frame's message, so a block
  sent down the error path would be invisible to most users.
- The web app re-reads the thread after `done` and offers a retry when it ends on an unanswered
  question. So the warning and the block have to be saved as part of the conversation, not only
  streamed.
- WhatsApp users cannot start a conversation; their one thread is replaced after 3 idle hours.
  The plan proposes separate wording for `source = whatsapp` threads.
- A limit check inside `runFacilitator` would need a new config getter in about 20 test files
  that mock `config` partially. The plan enforces at the routes and pins coverage with a
  source-scan test instead.

### Open

- 4 bytes per token rests on #399's evidence only (4.2 and 4.7 MB threads refused at 1,048,576
  tokens). The plan carries a calibration query and a count query for the architect to run.
- The Inkling prompt-too-large wording reaches the facilitator only after PR #401 merges; rebase
  onto `develop` then.
- Message wording is a proposal for the owner.

## Implement (2026-11-16)

Plan approved by the owner as written (relayed by the architect, 23:57Z), including the bytes/4
estimate, saving the notices into the conversation, and the wording with the WhatsApp variant.

### What shipped on the branch

- `lib/facilitator/history-limit.ts`: the estimate, the verdict, the messages and
  `limitThreadTurn`, which the two thread routes run the turn through.
- `lib/facilitator/history.ts`: `convertToGeminiHistory` moved out of `agent.ts` unchanged, so
  the estimate measures exactly what is sent. Moved rather than exported in place: every route
  test mocks `agent.ts` with `runFacilitator` only, and an export from the mocked module would
  have been undefined in all of them.
- `agent.ts`: `userFacingModelError` gives one plain sentence for a prompt over a model's limit.
- `/v2/mcp-complete` and `/api/v1/chat/completions`: 400 on block, before anything is saved.
- Config, `turbo.json`, `.env.example`, `docs/self-hosting.md`, `arch.md`.

### Departures from the plan

1. **No WhatsApp wording.** The plan chose it in apps/api by `thread.source`. Spec 329 says
   apps/api has no WhatsApp code, and source scan 5 fails on any line naming it under
   `apps/api/src` or `lib`, strings and comments included. I missed the scan at plan time.
   Raised with the architect, who put it to the owner with "one wording everywhere"
   recommended and told me to carry on with the single wording until he answers. Not decided.
2. `limitThreadTurn` takes a function that starts the facilitator, and the routes still write
   `runFacilitator(messageHistory)` themselves. Wrapping the call entirely would have dropped
   the count the #393 model-pin scan asserts (4 `runFacilitator` calls under `src`).
3. A fifth message, for API callers on the two stateless routes: "The conversation in this
   request is too long. Send fewer or shorter messages." The plan gave the status and shape but
   no text; "start a new conversation" means nothing to a caller that sends its own history.
4. The plan said `/v2/mcp-complete` tops out at 80k estimated tokens. It is about 60k: the body
   cap counts UTF-16 units and none encodes to more than three bytes. Still unreachable.

### Production counts (architect, Query B, bytes/4 over stored content)

web: 86 threads over 150k, 58 over 200k, of 105,920. legacy: 60 over 150k, 10 over 200k, of
39,327. leaderboard and ai-skill: 0. So 68 threads are blocked on their next message when this
ships. Two kinds: single pastes of 0.6 to 2 MB, and daily chats of 500 to 1,200 turns over
months. Query A (the bytes-per-token calibration) had not been run when I reached the gate, so
the ratio of 4 still rests on #399's evidence alone.

### Verification

- Each behaviour reverted in turn (six mutations); its tests fail each time (8, 4, 3, 4, 1 and
  5 failures) and pass restored. My first attempt at this passed everything because a zsh
  word-splitting slip applied no mutation at all; the mutation script now fails on an unknown
  name and prints the files it changed.
- `history-limit-thread-get.test.ts` runs both thread routes and thread GET against pglite:
  after a warned and a blocked turn every `content` is a bare string under the six frozen keys,
  and the thread never ends on an unanswered question.
- After merging `develop` (PR #401): api 1,396 passed / 3 skipped, typecheck, lint 0 errors,
  workspace build, under Node 22. One joint test with #401: the error the real Inkling client
  throws for the real context-window frame is the one that becomes the plain message.
- NOT run: anything against a live model, database or the deployed apps. No route was exercised
  over HTTP. That is the dev-approval gate's check.

### Pre-existing failure, not mine

`pnpm test` at the root with only `apps/api/.env.ci` loaded (porch's `tests` command) fails
`apps/auth/tests/service-verify.test.ts` at import: `@ansari/auth env validation failed`. It
passes with `apps/auth/.env.ci` loaded too, which is what CI's auth job does. Three of three
runs fail the same way; apps/auth and packages/ are identical to `develop` on this branch.
Left alone.

### Taking in develop

Merged `origin/develop` rather than rebasing: the branch was already pushed, and earlier builder
branches here merged. The architect's word was "rebase"; told them.

## Blocked at `porch done` (2026-11-17)

`porch done 400` ran its checks: `build` passed (48 s); `tests` failed, "Timed out after 300s".
The dev-approval gate is therefore NOT pending. Nothing bypassed; `status.yaml` untouched.

What I measured about that check (`sh -lc 'set -a; . ./apps/api/.env.ci; set +a; pnpm test'`),
all under Node 22, none of it touching files this branch changes:

- With only `apps/api/.env.ci`, as configured: `apps/auth/tests/service-verify.test.ts` fails at
  import, every time (4 of 4 runs), because it reads `getEnv()` while the file is collected and
  the auth variables are not set. The other four packages pass, api included (99 files).
- With `apps/auth/.env.ci` loaded as well: that suite passes, but in the one full run I made,
  `packages/auth/tests/config/rate-limit.test.ts` failed ("101 requests from one X-Real-IP") and
  turbo stopped the rest. Alone it passed 2 of 2, so I read it as load-sensitive, on one sample.
  That run took 116 s, so the 300 s timeout is not the normal case either.
- I do not know how earlier builders got this check to pass on the same `develop`.

Sent to the architect with the options: change the check in `.codev/config.json`, a recorded
manual bypass as on project 121, or something else. Waiting.

Correction to "Taking in develop" above: I had not yet told the architect about merging instead
of rebasing when I wrote that; it went in the same message as this block.

## Unblocked: dev-approval gate pending (2026-11-17)

Architect's word (00:39Z): make porch's `tests` check mirror CI, each app with its own env file,
one after the other, gentle on the machine; no bypass; merge instead of rebase is fine; the
single wording stands while the WhatsApp question is with the owner. Also (00:17Z): one test
command at a time, at most 2 vitest workers, changed files only until the final check. My
earlier runs had slowed the owner's machine.

**A mistake of mine, undone.** The worktree's `.codev/config.json` is a symlink to the main
workspace's file, not a copy. My first edit of the check went through it, so for about two
minutes the main config carried my untested command. Restored byte-for-byte from the copy read
at the start of the session, and told the architect. I should have looked at the file with
`ls -l` before writing to it. The override now lives in `.codev/config.local.json` in this
worktree only (codev's per-engineer layer, merged over `config.json`); untracked, not staged.

The check, run once by `porch done 400` under Node 22: `build` passed, `tests` passed in 545 s.

```
sh -lc '(set -a; . ./apps/api/.env.ci; set +a; pnpm exec turbo run test --concurrency=1 --filter ansari-api... -- --maxWorkers=2) && (set -a; . ./apps/auth/.env.ci; set +a; pnpm exec turbo run test --concurrency=1 --filter ansari-auth... -- --maxWorkers=2) && (pnpm exec turbo run test --concurrency=1 --filter ansari-eval... -- --maxWorkers=2) && (pnpm exec turbo run test --concurrency=1 --filter ansari-frontend... -- --maxWorkers=2)'
```

with `"timeout_ms": 1500000`. It covers the same five test tasks as the root `pnpm test`.
`packages/auth`'s rate-limit test passed in this serial run; its one earlier failure was in a
run with everything in parallel.

`porch next` reports `gate_pending: dev-approval`. Waiting for the human; not approving it myself.

## Owner decisions at the dev-approval gate (2026-11-17, 00:56Z, via the architect)

- WhatsApp wording: closed. One wording everywhere, no WhatsApp branch in apps/api. The plan's
  WhatsApp variant is superseded by this.
- The tests check above is now in the main `.codev/config.json`; my `config.local.json` is
  redundant and stays where it is.
- dev-approval is NOT approved. The owner asked the architect to run this branch locally with
  low thresholds first, from this worktree, read-only. I start no servers and no test runs
  until told otherwise.

## dev-approval: approved by the human, not yet recorded by porch (2026-11-17, 01:05Z)

The architect relayed the owner's explicit approval after running this branch locally
(thresholds 300/600, live model, throwaway database): warning appended to a real answer, block
in under a second on both thread routes with no model call, both saved, thread GET content still
a string, a new thread answers normally.

`porch approve 400 dev-approval --a-human-explicitly-approved-this` re-ran the checks and
refused: `build` passed, `tests` failed after 497 s. One test, in a file this branch does not
touch, hit vitest's 30 s limit:

    FAIL tests/migration/window-migration.test.ts > 0009 scaffold cleanup (scenario 15)
         > aborts on a row in any single scaffold table      34,772 ms   (limit 30,000)
    Test Files 1 failed | 98 passed (99)   Tests 1 failed | 1395 passed | 3 skipped

The whole api suite took 492 s where the gate run an hour earlier did all five packages in 545 s,
and the 5-minute load average at the end was 40 on 18 cores (other sessions were building at the
same time). Every test in that file was slow (3 to 11 s each). I read it as a timeout under
load, on one sample; the same test passed in the gate run. Not retried: the architect asked for
one capped run and for flakes to be reported, not retried until green. Waiting for their word.

## Review: PR #404 open, pr gate pending (2026-11-17)

- The rerun of `porch approve` the architect ordered (01:14Z, with air-403 holding its builds)
  passed: tests in 228 s. dev-approval recorded.
- Review file, lessons (cold section, hot map entry) and an amendments note on the plan
  committed. PR #404 opened against `develop`, body is the review file, `Fixes #400`.
- Consultation, single pass: codex APPROVE, claude APPROVE (two minor points, in the review's
  "Things to Look At", item 10). The gemini lane did NOT run: `agy` exited with code 3 and the
  file is a skip that porch reads as COMMENT. So two reviews, not three. Told the architect.
- `porch next` reports `gate_pending: pr`. Waiting for the human. Not merging.

## Architect's integration review of PR #404: two changes, made (2026-11-17)

Not sent to the owner yet. The architect's review (on the PR) asked for two changes in this PR.

1. **The warning vanished from cited answers in the web app.** `apps/frontend/lib/citations.ts`
   cuts a `Citations` heading and everything after it, and I had appended the warning after the
   answer. I had read the web app's stream handler and its re-read at plan time, but not what
   it does to the text it shows. Now the warning is sent just ahead of the answer's first text,
   so it is the first paragraph. `apps/frontend/lib/history-notice.test.ts` puts it through
   `resolveCitations`, `mapMessage`, `stripUnbackedCitations` and `stripStreamingCitations`,
   and asserts the old placement is lost on all four.
2. **One oversized message killed its thread.** Both thread routes stored the message first.
   Now a message over the block threshold on its own is answered "This message is too long for
   Ansari to read. Please send a shorter message." and nothing is stored. I did not write "or
   split it": the parts add up to the same size and the last one would block the thread.

Costs I found and recorded in the review: a one-sentence Arabic answer reads left-to-right in
the web app when the English warning is in front of it; the refused message's notice is on
screen in the web app only until reload (read from `chat-reconcile.ts`, not watched).

Not taken, the architect's two optional ideas: a size pre-check before loading a blocked
thread's history, and a Sentry count of warned and blocked turns.

Checks: six more mutations, each failing its tests (5, 5, 4, 2, 1, 3). One full serial run with
two workers: api 1,405 passed / 3 skipped, frontend 783, apps/auth 635, packages/auth 289 / 1
skipped, eval 145; typecheck and lint clean. Load average stayed under 12. Commit `e0ff7bbe`.
The `pr` gate is still pending and still the human's.
