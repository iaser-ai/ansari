# PIR Review: Warn at 150k and block at 200k tokens of thread history

Fixes #400

## Summary

Every turn sends the whole thread to the model, and nothing bounded it: production threads of
0.6 to 4.7 MB hung Gemini for 60 s or were refused at its 1,048,576-token limit. apps/api now
estimates a thread's size before any model call. From 150,000 estimated tokens the answer ends
with a notice asking the user to start a new conversation soon; from 200,000 no model is called
and the notice is the answer. A model that still refuses a prompt as too large now reaches the
user as one plain sentence, not the provider's error text.

What each entry point shows:

| Entry point | From 150,000 | From 200,000 |
|---|---|---|
| Web app, `POST /api/v2/threads/{id}/chat` | The answer, then the warning as its last paragraph | The block message as the answer |
| WhatsApp, same route | The same, in the reply message | The block message as the reply |
| Legacy mobile app, `POST /api/v2/threads/{id}` | The same, in the raw text stream | The block message as the answer |
| `POST /api/v2/mcp-complete` | Nothing | 400 `{"error": "The conversation in this request is too long. Send fewer or shorter messages."}` |
| `POST /api/v1/chat/completions` | Nothing | 400, OpenAI error shape, `invalid_request_error` / `context_length_exceeded`, same sentence |

On the three thread paths the notices are ordinary assistant text, streamed and stored, so no
client needed a change and thread GET still returns `content` as a bare string. The two stateless
routes refuse before saving anything. No new route, status or response shape; no schema change.

The wording:

- Warning: "Note: this conversation is getting long. Please start a new conversation soon. Ansari
  cannot continue a conversation beyond a certain length."
- Block: "This conversation has become too long for Ansari to continue. Please start a new
  conversation and ask your question there."
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
- `apps/api/lib/facilitator/history-limit.ts` (+106 / -0)
- `apps/api/lib/facilitator/history.ts` (+51 / -0)
- `apps/api/src/app/api/v1/chat/completions/route.ts` (+17 / -0)
- `apps/api/src/app/api/v2/mcp-complete/route.ts` (+13 / -0)
- `apps/api/src/app/api/v2/threads/[id]/chat/route.ts` (+5 / -1)
- `apps/api/src/app/api/v2/threads/[id]/route.ts` (+5 / -1)
- `apps/api/tests/config.test.ts` (+50 / -0)
- `apps/api/tests/facilitator-prompt-too-large.test.ts` (+185 / -0)
- `apps/api/tests/history-limit-routes.test.ts` (+244 / -0)
- `apps/api/tests/history-limit-thread-get.test.ts` (+215 / -0)
- `apps/api/tests/history-limit.test.ts` (+171 / -0)
- `apps/api/tests/inkling-client.test.ts` (+15 / -0)
- `apps/api/tests/mcp-complete.test.ts` (+76 / -0)
- `apps/api/tests/openai-compat.test.ts` (+72 / -1)
- `apps/api/tests/route-persistence-rollback.test.ts` (+6 / -1)
- `apps/api/tests/source-scan/history-limit-coverage.test.ts` (+162 / -0)
- `codev/plans/400-thread-history-is-unbounded-lo.md` (+313 / -0)
- `codev/projects/400-thread-history-is-unbounded-lo/status.yaml` (porch state)
- `codev/resources/arch.md` (+2 / -0)
- `codev/resources/lessons-critical.md` (+1 / -1)
- `codev/resources/lessons-learned.md` (+13 / -0)
- `codev/reviews/400-thread-history-is-unbounded-lo.md` (this file)
- `codev/state/pir-400_thread.md` (builder thread log)
- `docs/self-hosting.md` (+2 / -0)
- `turbo.json` (+4 / -0)

## Commits

Code and documents (porch's own state commits and the thread-log commits are left out):

- `b3030c2e` [PIR #400] Plan draft
- `2c4384fe` [PIR #400] Thread history thresholds in config: warn 150k, block 200k
- `07c632b3` [PIR #400] Warn and block on thread history size; plain message when a prompt is too large
- `7fed8c1f` [PIR #400] arch: thread history limits
- `e73003f0` Merge remote-tracking branch 'origin/develop' into builder/pir-400 (takes in PR #401)
- `c83d5596` [PIR #400] Tests: notices as thread GET returns them; the Inkling context-window error becomes the plain message
- [PIR #400] Review + retrospective (this commit)

## Test Results

All under Node 22, with each app's own `.env.ci`, as CI runs them.

- `pnpm build` (workspace): pass.
- Tests, porch's check at the dev-approval gate: pass.
  - apps/api: 99 files, 1,396 passed, 3 skipped. 45 tests are new.
  - apps/auth: 23 files, 635 passed. packages/auth: 18 files, 289 passed, 1 skipped.
  - apps/eval: 5 files, 145 passed. apps/frontend: 60 files, 774 passed.
- Typecheck: pass. Lint: 0 errors.
- Mutation check: each of six behaviours was reverted in turn and its tests failed every time
  (8, 4, 3, 4, 1 and 5 failures): the wrapper passing everything through, a thread route calling
  the facilitator bare, the raw provider text, the stateless routes never refusing, characters
  counted in place of bytes, and the warn-below-block rule.
- Manual verification, by the architect at the dev-approval gate: the api run from this branch
  with thresholds 300 and 600, a live model and a throwaway database. The warning was appended
  to a real answer; the block came back in under a second on both thread routes with no model
  call; both were saved; thread GET `content` was still a string; a new thread answered
  normally. The owner approved on that run.
- Not verified: the deployed apps, the real mobile app and WhatsApp end to end, and the two
  stateless routes against a live service. Their behaviour rests on the route tests.

## Architecture Updates

COLD only. `codev/resources/arch.md` gained one paragraph, "Thread history limits (issue #400)",
in "Gemini facilitator & message history" (commit `7fed8c1f`). It says how the size is
estimated, why `messages.input_tokens` is not the measure, where the limit is applied and why
the notices are stored as answer text.

Nothing was added to HOT `arch-critical.md`. The one cross-cutting fact this work leans on, that
single-text `content` must stay a bare string, is already there, and the file is at its cap.

## Lessons Learned Updates

COLD: a new section "Thread history limits (issue #400)" in `codev/resources/lessons-learned.md`,
eight entries:

- Ask what a stored counter sums before using it as a measure.
- A notice has to travel a path every client renders, and survive the client's re-read.
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
   daily chats of 500 to 1,200 turns.
3. **WhatsApp users get the same wording**, though they cannot start a conversation; their thread
   is replaced after 3 idle hours. The plan proposed separate wording chosen by thread `source`.
   apps/api may not name WhatsApp (spec 329, source scan 5), which the plan missed, and the
   owner chose one wording everywhere. A blocked WhatsApp user who keeps writing also keeps the
   thread alive, since each attempt is a saved message.
4. **A blocked turn still saves the user's message and the block message.** That is what stops
   the web app from showing its retry row, and it means a blocked thread keeps growing by a
   little each attempt. In the warning band every answer carries the warning.
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
10. **The pre-merge consultation was two reviews, not three.** Codex: APPROVE, no issues. Claude:
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
  - About 1,200 bytes of text in one thread: the answer ends with the warning after a blank
    line, and reloading the thread still shows it.
  - About 2,400 bytes: the block message is the answer, at once, on both
    `POST /api/v2/threads/{id}/chat` and `POST /api/v2/threads/{id}`. The api log has a
    `[history-limit]` line with the estimate and no model call.
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
