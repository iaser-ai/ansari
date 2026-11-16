# PIR Plan: Warn at 150k and block at 200k tokens of thread history

Issue #400. Scope is the owner's decision of 2026-11-16 (second comment on the issue): warn at
150,000 tokens, block at 200,000, a plain message when a prompt is too large for a model, every
entry point covered, no new route, status or response shape.

## Decisions needed at this gate

1. **The size is an estimate from the text, not the stored `input_tokens`.** This departs from the
   signal the issue suggests; reasons under "How the size is measured".
2. **The warning and the block are saved as part of the conversation**, not only streamed. Reasons
   under "What the user sees".
3. **The wording** of the five messages below, and whether WhatsApp gets its own wording.
4. Two production figures only the architect can get (queries under "Asks for the architect").

## Understanding

Every turn sends the whole thread to the model. The two thread routes load every message
(`apps/api/src/app/api/v2/threads/[id]/route.ts:173`, `.../[id]/chat/route.ts:67`) and hand the
list to `runFacilitator`, which converts all of it (`apps/api/lib/facilitator/agent.ts:347-387`,
`:468`). Nothing bounds it. On production this produced prompts of about 1M tokens, 60 s hangs,
three outright rejections by Gemini, and Inkling rescues that could never fit
(`codev/state/bugfix-399_thread.md`, builder bugfix-399).

What is replayed per earlier turn is the user's text and the assistant's final answer (the stored
`raw_payload`, or the text when there is none). Earlier turns' tool results are not replayed. So
a thread's size is its visible text, and a 4 MB thread is 4 MB of questions and answers.

Three more facts shape the design:

- **Clients.** The web app and WhatsApp both call `POST /api/v2/threads/{id}/chat` (SSE). The
  legacy mobile app calls `POST /api/v2/threads/{id}` (raw text) and shows whatever text arrives
  as the answer (`legacy/frontend-app/src/store/actions/chatActions.ts:45-66`).
- **Error frames are not shown to the user on two of the three clients.** The web app turns any
  `error` frame into its fixed "was not delivered. Check your connection, then retry" row
  (`apps/frontend/app/chat/[id].tsx:326-330`); WhatsApp sends its fixed "An error occurred while
  processing your message" (`legacy/whatsapp/.../whatsapp_conversation_manager.py:357-361`). Only
  the raw-text route shows the error's words. So a block sent down the error path would not tell
  most users why.
- **The web app re-reads the thread after every answer** (`apps/frontend/app/chat/[id].tsx:314-324`)
  and offers a retry when the thread ends on an unanswered question. Text that is streamed but not
  saved disappears at that moment.

## Proposed Change

### How the size is measured

Before any model call, estimate the tokens of the history that is about to be sent: the UTF-8
bytes of every text part `convertToGeminiHistory` produces (the new user message included),
divided by 4. The estimate is computed from the messages the route has already loaded, so it
costs no query and no network call, and it is the same for every thread, old or new.

**Why not the stored `input_tokens`.** It is the sum over every model call of the turn
(`agent.ts:532-545`; the column comment at `apps/api/db/schema/messages.ts:100-102` says the same).
A turn with three tool rounds makes four calls, each carrying the whole history plus the tool
results so far, so the stored figure is several times the thread's size, by a factor that changes
from turn to turn. Used as the measure, it would block a 50k-token thread after one tool-heavy
answer and pass it after a plain one. It is also absent on failed turns, on old rows and on a
thread's first turn, and a rescued turn stores Inkling's count rather than Gemini's. The estimate
needs no stored count at all, which also answers "test the thread with no stored count": every
thread takes that path.

**How good is 4 bytes per token.** The only evidence so far is #399's: threads whose thread GET
was 4.2 and 4.7 MB were refused at Gemini's 1,048,576-token limit. That is consistent with about
4 bytes per token and no more precise than that. Bytes rather than characters, because Arabic is
two bytes per character and takes more tokens per character than English. The thresholds sit at a
fifth of Gemini's limit, so an estimate that is off by a third still blocks long before the
failures in the issue. Not counted: the system prompt and tool declarations (about 2,300 tokens,
fixed) and `thoughtSignature` blobs in stored payloads, whose token cost I do not know. Query A
below would settle the ratio from production data; if it shows a different figure I will change
the constant before the PR.

The ratio is a named constant in code. The two thresholds are configuration.

### Thresholds

`THREAD_HISTORY_WARN_TOKENS` (default 150000) and `THREAD_HISTORY_BLOCK_TOKENS` (default 200000)
in the Zod schema: positive integers, and warn must be below block or validation fails. Exposed as
`config.threadHistory`. Added to `turbo.json` `globalEnv`, `apps/api/.env.example` and the env
table in `docs/self-hosting.md`.

### What the user sees

A new module, `apps/api/lib/facilitator/history-limit.ts`, holds the estimate, the verdict
(`ok | warn | block`), the message texts, and one wrapper the thread routes call in place of
`runFacilitator`:

- **block**: no model call. The wrapper yields the block message as a `text` event and then
  `done`. The routes' existing `done` handling streams it and saves it as an assistant message.
- **warn**: the facilitator runs as usual. Just before `done`, the wrapper yields the warning as
  one more `text` event, so it follows the answer in the stream and is saved with it. Nothing is
  added if the answer was empty.
- **ok**: events pass through untouched.

Each thread route changes one call. The frames and the stored row have the shapes they have today:
`content` stays a single text block, so thread GET still returns a bare string.

Saving is what makes this work on the web app. Without a saved answer, the re-read after `done`
finds a thread ending on an unanswered question and replaces the block message with "was not
delivered. Check your connection, then retry". Saved, it reads like any other exchange on all
three clients, including after a reload.

| Entry point | Warn (150k up to 200k) | Block (200k and over) |
|---|---|---|
| Web app, `POST /threads/{id}/chat` | Answer, then the warning as its last paragraph | The block message as the answer |
| Legacy mobile app, `POST /threads/{id}` | Same, in the raw text stream | Same, in the raw text stream |
| WhatsApp (same SSE route) | The warning ends the reply message | The block message is the reply |
| `/v2/mcp-complete` | Nothing | `400 {"error": …}` before anything is saved |
| `/api/v1/chat/completions` | Nothing | `400` in the OpenAI error shape, code `context_length_exceeded`, before anything is saved |

The two stateless routes get no warning: there is no conversation to restart, and appended text
would corrupt a benchmark answer. Both already return 400 for invalid input. At the default
thresholds `/v2/mcp-complete` cannot reach either one (20 messages of 4,000 characters is at most
80k estimated tokens); `/api/v1/chat/completions` can reach the block only with near-maximum
input in a three-byte script. The check is there so the rule holds if those caps change.

**Proposed wording** (English, like every other fixed message the API sends; please edit):

- Warning: "Note: this conversation is getting long. Please start a new conversation soon. Ansari
  cannot continue a conversation beyond a certain length."
- Block: "This conversation has become too long for Ansari to continue. Please start a new
  conversation and ask your question there."
- WhatsApp has no way to start a conversation: its one thread is replaced after 3 hours without
  a message. For threads whose `source` is `whatsapp` I propose: warning "Note: this conversation
  is getting long. Ansari cannot continue a conversation beyond a certain length. A new one starts
  automatically after a few hours without messages." and block "This conversation has become too
  long for Ansari to continue. A new one starts automatically after a few hours without messages.
  Please ask again then." The alternative is one wording everywhere.
- Prompt too large for a model (below): "Ansari could not answer because this conversation is too
  long. Please try again, or start a new conversation."

### Plain message when a prompt is too large for a model

In `runFacilitator`'s terminal `catch` (`agent.ts:1080-1087`), an error that says the prompt
exceeds the model's limit yields the plain message above instead of the provider's text. The raw
error still goes to the log and Sentry. Recognised by the provider's own words: Gemini's "input
token count exceeds the maximum number of tokens" and Inkling's "exceeds the model's context
window". Any other error is passed through as today.

Where it shows: the legacy mobile route (`Error: …` after the stream, as now), `/v2/mcp-complete`
and `/api/v1/chat/completions` (their 500 bodies). The web app and WhatsApp keep showing their
own fixed error text, because they never display an error frame's message.

Inkling's wording only reaches this code once PR #401 is merged; until then that failure still
reads "truncated after 0 chars". I will rebase onto `develop` after #401 lands and test against
the frame its test uses.

### Keeping every entry point covered

A source-scan test under `apps/api/tests/source-scan/` (next to `facilitator-model-pin.test.ts`):
any file under `apps/api/src` that calls `runFacilitator` must also call the limit check, and the
two thread routes must go through the wrapper. The scan is itself tested against a known-bad file
and a near-miss.

`runFacilitator` itself gets no limit check. I considered a backstop there; about 20 facilitator
test files replace `config` with a partial mock, and each would need the new getter for a check
the routes already make. The evaluation harness calls `runFacilitator` directly and is not
covered; its question sets are a few hundred tokens.

### Not solved here

- Threads between about 57k and 200k tokens still cannot be rescued by Inkling (its window is
  65,536 tokens including the answer). After this change such a rescue fails in under a second
  with the plain message instead of provider text.
- Threads already over 200k tokens are blocked from their next message. They stay readable; thread
  GET is unchanged and still returns several MB for the largest. How many there are is Query B.
- A blocked thread still loads its full history from the database on each attempt before the
  check runs.
- The 7 Gemini hangs on short threads in #399 are a different problem.

## Files to Change

- `apps/api/lib/facilitator/history-limit.ts`: new. `estimateHistoryTokens`, `assessHistory`,
  the message constants, `runThreadTurn(messages, { threadId, source })`. One log line per warn
  or block with the thread id, the verdict and the estimate; no content.
- `apps/api/lib/facilitator/agent.ts:347`: export `convertToGeminiHistory` so the estimate
  measures exactly what is sent.
- `apps/api/lib/facilitator/agent.ts:1080-1087`: plain message for prompt-too-large errors.
- `apps/api/src/app/api/v2/threads/[id]/route.ts:231` and
  `apps/api/src/app/api/v2/threads/[id]/chat/route.ts:106`: call `runThreadTurn` instead of
  `runFacilitator`.
- `apps/api/src/app/api/v2/mcp-complete/route.ts:251-258`: 400 on block, before the transaction.
- `apps/api/src/app/api/v1/chat/completions/route.ts:320-324`: 400 on block, before the
  transaction.
- `apps/api/lib/config.ts`: the two variables, the ordering rule, `config.threadHistory`.
- `turbo.json`, `apps/api/.env.example`, `docs/self-hosting.md`: the two variables.
- `codev/resources/arch.md` ("Gemini facilitator & message history"): a short paragraph on the
  limit, the estimate and where the notices are stored.
- Tests: new `apps/api/tests/history-limit.test.ts`, `apps/api/tests/history-limit-routes.test.ts`,
  `apps/api/tests/source-scan/history-limit-coverage.test.ts`; additions to `config.test.ts`,
  `mcp-complete.test.ts`, `openai-compat.test.ts` and a facilitator error-path test. Existing
  route tests that mock `@/lib/config` gain the `threadHistory` getter where they need it.

No schema change, no migration, no frontend or WhatsApp change.

## Risks & Alternatives Considered

- **Risk: the notices become part of the conversation.** They appear in thread GET, in a shared
  snapshot, and in admin message counts as assistant messages. The warning is not in the stored
  `raw_payload`, so the model does not see its own warnings on replay; a block message would be
  replayed as an assistant turn only if the block threshold were later raised.
- **Risk: a warned thread repeats the warning on every answer** until it is blocked. Intended.
- **Risk: the estimate is wrong for some content** (heavily vowelled Arabic, long digit runs).
  Bounded by the distance between the thresholds and the model limit; Query A measures it.
- **Risk: recognising "prompt too large" by provider wording breaks when a provider rewords it.**
  The failure then shows the raw text, as today. Tests pin the two current wordings.
- **Risk: a blocked WhatsApp user who keeps retrying keeps their thread alive**, since each
  attempt is a saved message and restarts the 3-hour clock. The proposed WhatsApp wording says to
  wait. A WhatsApp thread reaching 200k tokens needs hundreds of turns with no 3-hour pause.
- **Alternative: stored `input_tokens` as the measure.** Rejected above.
- **Alternative: a new column holding the first call's prompt tokens.** Exact for Gemini, but
  needs a migration applied by hand before deploy, still needs the estimate for old rows, failed
  turns and the newest message, and gives two measures that can disagree at the threshold.
- **Alternative: ask Gemini to count tokens before each turn.** Exact, but adds a network call and
  a new failure mode to every turn, and sends the 4 MB payload once more for the threads that are
  the problem.
- **Alternative: stream the notices without saving them.** The web app would replace the block
  message with its retry row, and the warning would vanish when the answer is re-read.
- **Alternative: send the block down the error path.** Only the legacy mobile app would show it.

## Asks for the architect

Aggregates only, no content. Neither blocks the implementation; both go in the PR if available.

Query A, bytes of earlier visible text per reported prompt token, on single-call Gemini turns:

```sql
WITH turns AS (
  SELECT id, thread_id, created_at, input_tokens
  FROM messages
  WHERE role = 'assistant' AND tool_calls IS NULL
    AND model_provider = 'gemini' AND input_tokens >= 20000
), sized AS (
  SELECT t.id, t.input_tokens,
         sum(octet_length(p.content::text)) AS content_bytes,
         sum(octet_length(coalesce(p.raw_payload::text, ''))) AS payload_bytes
  FROM turns t
  JOIN messages p ON p.thread_id = t.thread_id
                 AND (p.created_at, p.id) < (t.created_at, t.id)
  GROUP BY t.id, t.input_tokens
)
SELECT count(*) AS turns,
       percentile_cont(ARRAY[0.05, 0.5, 0.95]) WITHIN GROUP (ORDER BY content_bytes::float / input_tokens) AS content_bytes_per_token,
       percentile_cont(ARRAY[0.05, 0.5, 0.95]) WITHIN GROUP (ORDER BY payload_bytes::float / input_tokens) AS payload_bytes_per_token
FROM sized;
```

Query B, how many threads are over each threshold today, by source:

```sql
SELECT t.source,
       count(*) FILTER (WHERE s.est >= 150000) AS over_150k,
       count(*) FILTER (WHERE s.est >= 200000) AS over_200k,
       count(*) AS threads
FROM (SELECT thread_id, sum(octet_length(content::text)) / 4 AS est
      FROM messages GROUP BY thread_id) s
JOIN threads t ON t.id = s.thread_id
GROUP BY t.source;
```

## Test Plan

Unit (`history-limit.test.ts`, `config.test.ts`):
- The estimate for English, Arabic and mixed text; for an assistant message with a stored
  payload and one without; with a `thoughtSignature` present (not counted).
- A long thread whose rows have no stored `input_tokens` is blocked; a short thread whose last row
  stores a huge `input_tokens` is not.
- Verdicts one token under and exactly at each threshold.
- Config: the defaults, an override of each, warn equal to or above block rejected, a
  non-integer rejected.

Routes (`history-limit-routes.test.ts`, both thread routes, thresholds set low):
- Warn: the facilitator runs; the stream is the answer followed by the warning; the saved content
  is one text block holding both; the SSE route ends with `done`.
- Warn with an empty answer: the existing empty-answer error, nothing saved.
- Block: the facilitator is never called; the stream is the block message (and `done` on SSE); an
  assistant row is saved with no token counts.
- A thread whose `source` is `whatsapp` gets the WhatsApp wording.
- `/v2/mcp-complete` and `/api/v1/chat/completions`: 400 in each route's error shape, no thread
  created, the facilitator never called; under the threshold nothing changes.

Facilitator: a Gemini "input token count exceeds…" error and an Inkling "exceeds the model's
context window" error each yield the plain message; another error still yields its own text.

Source scan: fails on a fixture route that calls `runFacilitator` without the check, passes on
the near-miss, and reports how many files it examined.

Unchanged and still passing: `thread-get-contract.test.ts` (bare-string `content`) and the full
api suite, typecheck, lint and build under Node 22.

Manual, for the dev-approval gate, with `THREAD_HISTORY_WARN_TOKENS=300` and
`THREAD_HISTORY_BLOCK_TOKENS=600` in the worktree's env:
- Web app: a few turns until the warning ends an answer; reload and see it still there; continue
  until the block message arrives as the answer with no model wait; reload again; start a new
  conversation and get a normal answer.
- Legacy route: `curl` `POST /api/v2/threads/{id}` on the same thread and read the block text.
- WhatsApp wording: create a thread with `source: "whatsapp"` and `curl` the SSE route past both
  thresholds.
- Not verifiable locally: the Inkling prompt-too-large message against the live endpoint. That
  needs the production key, so it is the architect's to run after #401 merges.
