# PIR Review: Warn at 150k and block at 200k tokens of thread history

Fixes #400

## Summary

Every turn sends the whole thread to the model, and nothing bounded it: production threads of
0.6 to 4.7 MB hung Gemini for 60 s or were refused at its 1,048,576-token limit. apps/api now
estimates a thread's size before any model call. From 150,000 estimated tokens the answer opens
with a notice asking the user to start a new conversation soon; from 200,000 no model is called
and the notice is the answer. One incoming message that is over 200,000 on its own is told the
message is too long and is not stored, so the thread it was sent to stays usable. A model that
still refuses a prompt as too large now reaches the user as one plain sentence, not the
provider's error text.

What each entry point shows:

| Entry point | From 150,000 | From 200,000 |
|---|---|---|
| Web app, `POST /api/v2/threads/{id}/chat` | The warning as the answer's first paragraph, then the answer | The block message as the answer |
| WhatsApp, same route | The same, in the reply message | The block message as the reply |
| Legacy mobile app, `POST /api/v2/threads/{id}` | The same, in the raw text stream | The block message as the answer |
| `POST /api/v2/mcp-complete` | Nothing | 400 `{"error": "The conversation in this request is too long. Send fewer or shorter messages."}` |
| `POST /api/v1/chat/completions` | Nothing | 400, OpenAI error shape, `invalid_request_error` / `context_length_exceeded`, same sentence |

On the three thread paths the notices are ordinary assistant text, streamed and stored, so no
client needed a change and thread GET still returns `content` as a bare string. The two stateless
routes refuse before saving anything. No new route, status or response shape; no schema change.

The warning comes first because the web app cuts a `Citations` heading and everything after it
from what it shows. In the first version of this PR the warning followed the answer, and so
vanished from every answer that cited a source. The architect's integration review caught it.

One message over the block threshold on its own (a pasted book, say) is a separate case on the
two thread routes. It is answered at once in the same shapes, the stream on one route and a text
frame then `done` on the other, and nothing is saved: neither the message nor the answer. Saved,
it would count against the thread on every later turn and the thread could never be used again.

The wording:

- Warning: "Note: this conversation is getting long. Please start a new conversation soon. Ansari
  cannot continue a conversation beyond a certain length."
- Block: "This conversation has become too long for Ansari to continue. Please start a new
  conversation and ask your question there."
- One message too long: "This message is too long for Ansari to read. Please send a shorter
  message."
- Prompt too large for a model: "Ansari could not answer because this conversation is too long.
  Please try again, or start a new conversation."

The thresholds are `THREAD_HISTORY_WARN_TOKENS` and `THREAD_HISTORY_BLOCK_TOKENS`, validated in
the Zod config (positive integers, warn below block), with the defaults above. Production needs
no new variable.

**Not solved, as the issue says:** a thread between about 57,000 and 200,000 tokens still cannot
be rescued by Inkling when Gemini fails, because Inkling's window is 65,536 tokens. Those users
now get the plain sentence where they used to get the provider's error.

## Files Changed

- `apps/api/.env.example` (+6 / -0)
- `apps/api/lib/config.ts` (+32 / -0)
- `apps/api/lib/facilitator/agent.ts` (+20 / -50)
- `apps/api/lib/facilitator/history-limit.ts` (+133 / -0)
- `apps/api/lib/facilitator/history.ts` (+51 / -0)
- `apps/api/src/app/api/v1/chat/completions/route.ts` (+17 / -0)
- `apps/api/src/app/api/v2/mcp-complete/route.ts` (+13 / -0)
- `apps/api/src/app/api/v2/threads/[id]/chat/route.ts` (+21 / -8)
- `apps/api/src/app/api/v2/threads/[id]/route.ts` (+18 / -8)
- `apps/api/tests/config.test.ts` (+50 / -0)
- `apps/api/tests/facilitator-prompt-too-large.test.ts` (+185 / -0)
- `apps/api/tests/history-limit-routes.test.ts` (+296 / -0)
- `apps/api/tests/history-limit-thread-get.test.ts` (+255 / -0)
- `apps/api/tests/history-limit.test.ts` (+197 / -0)
- `apps/api/tests/inkling-client.test.ts` (+15 / -0)
- `apps/api/tests/mcp-complete.test.ts` (+76 / -0)
- `apps/api/tests/openai-compat.test.ts` (+72 / -1)
- `apps/api/tests/route-persistence-rollback.test.ts` (+6 / -1)
- `apps/api/tests/source-scan/history-limit-coverage.test.ts` (+162 / -0)
- `apps/frontend/lib/history-notice.test.ts` (+133 / -0)
- `codev/plans/400-thread-history-is-unbounded-lo.md` (+318 / -0)
- `codev/resources/arch.md` (+2 / -0)
- `codev/resources/lessons-critical.md` (+1 / -1)
- `codev/resources/lessons-learned.md` (+14 / -0)
- `docs/self-hosting.md` (+2 / -0)
- `turbo.json` (+4 / -0)
- `codev/projects/400-thread-history-is-unbounded-lo/` (porch state and the three consultation outputs)
- `codev/reviews/400-thread-history-is-unbounded-lo.md` (this file)
- `codev/state/pir-400_thread.md` (builder thread log)

## Commits

Code and documents (porch's own state commits and the thread-log commits are left out):

- `b3030c2e` [PIR #400] Plan draft
- `2c4384fe` [PIR #400] Thread history thresholds in config: warn 150k, block 200k
- `07c632b3` [PIR #400] Warn and block on thread history size; plain message when a prompt is too large
- `7fed8c1f` [PIR #400] arch: thread history limits
- `e73003f0` Merge remote-tracking branch 'origin/develop' into builder/pir-400 (takes in PR #401)
- `c83d5596` [PIR #400] Tests: notices as thread GET returns them; the Inkling context-window error becomes the plain message
- `f631bf87` [PIR #400] Review + retrospective
- `e0ff7bbe` [PIR #400] Warning opens the answer so the web app's Citations cut keeps it; an oversized single message is refused and not stored

## Test Results

All under Node 22, with each app's own `.env.ci`, as CI runs them, on the final code (`e0ff7bbe`).

- `pnpm build` (workspace): pass at the dev-approval gate; not rebuilt after the two later
  changes, which CI builds.
- Tests, one serial run with two workers: pass.
  - apps/api: 99 files, 1,405 passed, 3 skipped. 54 tests are new.
  - apps/frontend: 61 files, 783 passed. 9 tests are new, in `lib/history-notice.test.ts`.
  - apps/auth: 23 files, 635 passed. packages/auth: 18 files, 289 passed, 1 skipped.
  - apps/eval: 5 files, 145 passed.
- Typecheck (api, frontend): pass. Lint: 0 errors.
- Mutation check: each of twelve behaviours was reverted in turn and its tests failed every
  time. Six at the dev-approval gate (8, 4, 3, 4, 1 and 5 failures): the wrapper passing
  everything through, a thread route calling the facilitator bare, the raw provider text, the
  stateless routes never refusing, characters counted in place of bytes, and the warn-below-block
  rule. Six for the two later changes (5, 5, 4, 2, 1 and 3 failures): the warning after the
  answer, an oversized message never refused, each thread route skipping that check, its size
  counted in characters, and the check made after the message is stored.
- The frontend test also asserts that the old placement (warning after the `Citations` section)
  loses the warning on all four display paths, so the test is shown able to see the defect.
- Manual verification, by the architect at the dev-approval gate, on the FIRST version (warning
  after the answer): the api run from this branch with thresholds 300 and 600, a live model and
  a throwaway database. The warning was appended to a real answer; the block came back in under
  a second on both thread routes with no model call; both were saved; thread GET `content` was
  still a string; a new thread answered normally. The owner approved on that run.
- Not verified: the two later changes in a running app or browser. The deployed apps, the real
  mobile app and WhatsApp end to end, and the two stateless routes against a live service.
  Their behaviour rests on the tests.

## Architecture Updates

COLD only. `codev/resources/arch.md` gained one paragraph, "Thread history limits (issue #400)",
in "Gemini facilitator & message history" (commit `7fed8c1f`). It says how the size is
estimated, why `messages.input_tokens` is not the measure, where the limit is applied, why the
notices are stored as answer text, why the warning comes first, and that an oversized single
message is refused without being stored.

Nothing was added to HOT `arch-critical.md`. The one cross-cutting fact this work leans on, that
single-text `content` must stay a bare string, is already there, and the file is at its cap.

## Lessons Learned Updates

COLD: a new section "Thread history limits (issue #400)" in `codev/resources/lessons-learned.md`,
nine entries:

- Ask what a stored counter sums before using it as a measure.
- A notice has to travel a path every client renders, and survive the client's re-read.
- Text added to an answer passes through every transform the client applies to answers.
- Put a new function where the test mocks do not reach.
- Before wrapping a call, look for scans that count it.
- A mutation harness must fail when it applies nothing.
- A character cap is not a byte cap.
- A builder worktree's `.codev/config.json` is a symlink to the main checkout's file.
- porch's `tests` check runs each app with its own env file, serially.

HOT: `lessons-critical.md` gained no lesson. Its map entry for "Gemini history fidelity" now
also names this section, so the map still matches the cold file and stays at 34 lines.

## Things to Look At During PR Review

1. **The size is an estimate, and its ratio is not calibrated.** UTF-8 bytes of the text about
   to be sent, divided by 4 (`BYTES_PER_TOKEN` in `history-limit.ts`). The only evidence is
   #399's: threads of 4.2 and 4.7 MB were refused at 1,048,576 tokens, which is about 4 bytes a
   token. The calibration query in the plan was not run. Arabic-heavy threads may tokenize
   differently. The system prompt and tool declarations (about 2,300 tokens) are not counted.
2. **68 production threads are blocked on their next message when this ships** (58 web, 10
   legacy), by the architect's count over stored content with the same estimate. Another 78 are
   between the thresholds and will see the warning. They are single pastes of 0.6 to 2 MB and
   daily chats of 500 to 1,200 turns. A thread that already holds a stored oversized paste
   stays blocked; refusing such a message protects threads only from now on.
3. **WhatsApp users get the same wording**, though they cannot start a conversation; their thread
   is replaced after 3 idle hours. The plan proposed separate wording chosen by thread `source`.
   apps/api may not name WhatsApp (spec 329, source scan 5), which the plan missed, and the
   owner chose one wording everywhere. A blocked WhatsApp user who keeps writing also keeps the
   thread alive, since each attempt is a saved message.
4. **A blocked turn still saves the user's message and the block message.** That is what stops
   the web app from showing its retry row, and it means a blocked thread keeps growing by a
   little each attempt. In the warning band every answer carries the warning.
   An oversized single message is the opposite: nothing is saved. In the web app its answer
   stays on screen for that visit (the streamed bubble is kept until a saved answer replaces
   it, and none does) and is gone after a reload, along with the question. I read that from
   `lib/chat-reconcile.ts`; it has not been watched in a browser.
5. **The sentence for API callers was not in the approved plan:** "The conversation in this
   request is too long. Send fewer or shorter messages." The plan gave the status and shape
   only. `/v2/mcp-complete` cannot reach the block at its current body cap (about 60k estimated
   tokens); the check is there so a raised cap does not reopen the hole.
6. **The limit is applied by the routes, not inside `runFacilitator`.** A route added later that
   calls the facilitator without it fails `tests/source-scan/history-limit-coverage.test.ts`.
   The scan reads the TypeScript AST, is tested on planted lines and near-misses, and asserts
   exactly which four files it found.
7. **`convertToGeminiHistory` moved** from `agent.ts` to `lib/facilitator/history.ts`, unchanged.
   The `agent.ts` diff is that move plus `userFacingModelError`.
8. **The prompt-too-large match is two regular expressions over provider wording**
   (`PROMPT_TOO_LARGE_ERRORS` in `agent.ts`). Only one Gemini wording is on record, quoted in
   #399's notes, and one Inkling frame from PR #401. A provider that rewords its error brings
   the raw text back; nothing breaks.
9. **Process, not code.** While changing porch's `tests` check I wrote through a symlink and
   changed the main workspace's `.codev/config.json` for about two minutes. I restored it
   byte-for-byte and told the architect, who has since put the new check there on purpose.
   Nothing in this PR touches that file; it is gitignored.
10. **The warning's placement has two costs.** The web app sets an answer's direction from its
    share of Arabic letters, and the English warning counts: an Arabic answer of a sentence or
    two reads left-to-right when warned (about 170 Arabic letters are needed to outweigh it;
    `apps/frontend/lib/history-notice.test.ts` pins both sides). And an answer whose stored
    model payload is missing is replayed to the model from its text, warning included; in the
    warning band answers come from Gemini and carry a payload, so this should be rare.
11. **The too-long-message wording does not suggest splitting the text**, though the review
    that asked for it offered "shorter text, or split it". A message over the block threshold,
    split, adds up to the same size, so its last part would block the thread.
12. **Two suggestions from the integration review were not taken:** a size pre-check so a
    blocked thread does not load its history on each retry, and a Sentry message counting
    warned and blocked turns. The first needs a second, different measure of size in SQL. For
    the second, each such turn already logs one `[history-limit]` line with the estimate and no
    content. Both are easy to add later.
13. **The two later changes came after the consultation** (the warning's placement and the
    oversized message, commit `e0ff7bbe`) and were not seen by its reviewers. They answer the
    architect's integration review of this PR.
14. **The pre-merge consultation was two reviews, not three.** Codex: APPROVE, no issues. Claude:
    APPROVE, with two minor points, neither changed in this PR. The Gemini lane did not run (its
    CLI exited with code 3) and its file records a skip, which porch counts as COMMENT. The two
    points:
    - The source scan accepts a stateless route if its file calls `assessHistory` anywhere; it
      does not check that the verdict is acted on. The route tests cover today's two callers.
    - For Arabic-heavy threads the estimate's error could go either way. The block sits about
      five times below Gemini's limit, so this cannot bring the original failure back; it adds
      to item 1's case for measuring the ratio.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-400 → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-400`
- **What to verify**, with `THREAD_HISTORY_WARN_TOKENS=300` and `THREAD_HISTORY_BLOCK_TOKENS=600`
  in the api's env (warn must be below block or the api refuses to start):
  - A short thread answers as before, with no notice.
  - About 1,200 bytes of text in one thread: the answer opens with the warning, then a blank
    line, then the answer, and reloading the thread still shows it. Ask something that makes
    the model cite a source (a verse, a hadith): the warning must still be there in the web
    app, live and after a reload.
  - About 2,400 bytes: the block message is the answer, at once, on both
    `POST /api/v2/threads/{id}/chat` and `POST /api/v2/threads/{id}`. The api log has a
    `[history-limit]` line with the estimate and no model call.
  - One message of 2,400 bytes or more on a fresh thread: "This message is too long for Ansari
    to read…", at once. The thread is still empty on reload and answers a normal question.
  - Thread GET returns every `content` as a string.
  - A new thread answers normally.
  - `POST /api/v1/chat/completions` with a long `messages` array returns 400 with code
    `context_length_exceeded`.

## Flaky Tests

Both pre-existing, both in files this PR does not touch, both left running and unchanged.

- `apps/api/tests/migration/window-migration.test.ts:144`, "aborts on a row in any single
  scaffold table": timed out once at vitest's 30 s limit (34.8 s) while the machine's 5-minute
  load average was 40 on 18 cores. It passed in the run before and the run after.
- `packages/auth/tests/config/rate-limit.test.ts:69`, "/sign-in/email: 101 requests from one
  X-Real-IP, none refused by the router": failed once in a run with every package in parallel.
  It passed alone twice and in both serial runs.
