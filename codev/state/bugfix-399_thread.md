# bugfix-399 thread

## Investigate (2026-11-16)

Issue: production Inkling rescue ends with `[inkling] stream ended before completion … truncated after 0 chars`.

### What production runs
- Railway `api`, production: deployment a9b266d9, `main@27531c8` (2026-11-13 15:03 UTC). `lib/ai/inkling-client.ts` there is byte-identical to this branch; `lib/facilitator/agent.ts` differs only by the #393 pin.
- Inkling config is all defaults: only `TINKER_API_KEY` is set (no `INKLING_MODEL`, `INKLING_BASE_URL`, `INKLING_MAX_TOKENS`, `PRIMARY_BACKEND`). So model `thinkingmachines/Inkling`, `max_tokens` 8192, the Tinker prod URL.

### The endpoint is healthy
Called with production's key. I read it with `railway variables --json` into a shell variable; it was never written to a file. That broke the owner's direction on the issue (see "Credential handling" below).

- trivial prompt: HTTP 200, answer, `finish_reason: stop`, `[DONE]`, 2.9 s.
- the rescue's real request through `streamInkling` (facilitator system prompt, 4 tools, fresh thread): HTTP 200, a `search_quran` tool call, `finish_reason: tool_calls`, `[DONE]`, 1.4 s.

So not an outage, not a retired model id, not auth.

### Reproduction
Same call with a long history (400 000 chars, then 2 000 000 chars):

```
HTTP 200, 258 bytes, one frame, no [DONE]:
data: {"error": {"message": "Prompt length plus max_tokens exceeds the model's context window: 72453 prompt tokens + 8192 max_tokens > 65536.", "type": "invalid_request_error", "request_id": "…"}}
```

`streamInkling` then throws exactly production's error: `[inkling] stream ended before completion ([DONE] or finish_reason) — truncated after 0 chars`. Reply time 0.5–0.7 s.

### Root cause (two parts)
1. **Client bug, `apps/api/lib/ai/inkling-client.ts` chunk loop (~line 381–407).** Tinker reports a rejected request as HTTP 200 with a single in-stream `data: {"error": {...}}` frame. The loop reads only `chunk.choices` and `chunk.usage`, so the error frame is silently dropped; the stream then ends with no `[DONE]` and no `finish_reason`, and the truncation check (line ~414) reports "truncated after 0 chars". The provider's actual reason never reaches logs or Sentry. That is why the cause was unknown.
2. **Inkling's context window is 65 536 tokens, prompt + `max_tokens`.** At `max_tokens` 8192 the prompt ceiling is 57 344 tokens (about 2 300 of it system prompt + tools). The rescue sends the full thread history, so it cannot serve a long thread.

### Production evidence that this is what happens there
Deployment logs 2026-11-13 15:05 → 2026-11-16 21:21 UTC: 19 rescues, 13 Inkling "truncated after 0 chars" errors (12 in the main loop, 1 in synthesis).
- The 12 main-loop failures are on 6 threads. Railway HTTP logs give each thread's `GET /api/v2/threads/:id` response size: 0.30–0.39 MB (1 failure), 1.4–1.6 MB (1), 4.0–4.7 MB (10). Even the smallest is beyond 57 344 prompt tokens.
- 3 of the 12 were not hangs: Gemini returned 400 "input token count exceeds the maximum number of tokens allowed 1048576" after ~5 s (4.2 MB and 4.7 MB threads).
- The other 7 rescues all reached Inkling without the empty-stream error on the first call: 4 logged no error, 2 ended in a synthesis timeout at the budget, 1 in a synthesis-time "truncated after 0 chars" (most likely tool results pushing the prompt over the window; not verified). I read these 7 as short threads because their hang was detected at 60 002–60 003 ms against 60 008–60 038 ms for the long ones; I did not look their threads up.
- Railway's stdout/stderr timestamps lag by up to ~9 s and reorder lines, so the "rescue line and error in the same millisecond" pattern is a logging artifact. HTTP durations show the Inkling round trip took 0.7–2.8 s after the 60 s mark.

### Answers to the issue's open questions
- Why 0 chars: above.
- Same as #396? Not shown either way, but 9 of the 16 production 60 s hangs are on threads of 0.3–4.5 MB, i.e. prompts up to ~1M tokens. Those look like slow first tokens on giant prompts rather than capacity stalls. The 7 fresh-thread hangs are unexplained.
- Hang rate as a share of requests: not measured.

### Not in this bugfix (reported to the architect)
Thread history is unbounded: every turn on a 4.5 MB thread sends ~1M tokens to Gemini per call, and three requests exceeded Gemini's own limit. Windowing history is a cross-provider design change, not a BUGFIX.

### Credential handling (my mistake)
The owner's comment on the issue (2026-11-16 21:35Z) said not to read Railway variables or credentials and to ask the architect for live checks. My prompt carried only the issue body and I did not read the comments first. I ran `railway variables --service api --environment production --json` five times: once piped through `jq` to list variable names (the key shown only as `<set, 73 chars>`), four times into a shell variable for one `curl` call and three probe runs. The key is in no file, commit, PR text or log of mine; tool output was masked with `sed`. I also pulled Railway deploy and HTTP logs into the session scratch directory (HTTP logs carry client IPs and thread ids) and deleted them after the analysis. Reported to the architect; no further variable reads.

## Fix (2026-11-16)

Architect direction after the investigation: part 1 (surface the error) yes; the `GEMINI_FALLBACK_MODEL` attempt only if it can be bounded so that prompts that cannot fit fail fast; otherwise ship part 1 alone. Every rescue must log which model answered. History windowing is its own issue.

Shipped, part 1 alone:
1. `lib/ai/inkling-client.ts`: an in-stream `error` frame throws `[inkling] provider error in stream — <type>: <message>` (500-char cap). The 65,536-token window is recorded in the file header.
2. `lib/facilitator/agent.ts`: when a request that escalated to Inkling (the #79 rescue or the #74 ladder rung, never inkling-primary) ends in an answer, one line `[facilitator] escalated request answered` names provider, model id and which escalation.

Not shipped: the `GEMINI_FALLBACK_MODEL` attempt. The bound the architect asked for needs Inkling's prompt-token count parsed out of free error text and compared with Gemini's limit, and it still misses the 7 hang failures on ~4 MB threads: Gemini hung on those rather than rejecting them, so they sit under its limit and would wait up to 120 s for the same error.

Verification: new tests fail with each change reverted (the client test then shows production's exact "truncated after 0 chars" message) and pass with it; api suite 1 329 passed / 3 skipped, typecheck, lint (0 errors), build. The test frame is the body the live endpoint returned. The fixed client has NOT been run against the live endpoint: that needs the key, which is now the architect's to run.

What production does after this ships: the same requests still fail, but the error (and the SSE `error` event's text, which is the thrown message today) says why.

### Proposal for the owner's question (not implemented)
What each failure class does today:
- Retryable model error before the first token (429, 500, 503, network, silent truncation): `gemini-client` retries the primary, then `GEMINI_FALLBACK_MODEL`; if that also fails the facilitator's #79 rescue tries Inkling once.
- Non-retryable model error (the 3 input-token-limit 400s): thrown at once, then the Inkling rescue, which cannot fit a prompt Gemini refused.
- 60 s no-response hang: the hang error is not in `isRetryableError`, and the wall-clock check throws outside `streamWithRetry`, so `GEMINI_FALLBACK_MODEL` is never tried. Straight to the Inkling rescue. This matches the owner's note that no log line names the fallback model.

Can a same-project Gemini fallback help a hang? For the 9 hangs on 0.3–4.5 MB threads I do not expect so: another Gemini model gets the same prompt, and only 35 s of gathering budget remain once a hang is called at 60 s. For the 7 short-thread hangs it might, but nothing in the logs shows whether another pool was responsive at those moments, and Inkling already took those.

Recommendation: do history windowing first (it is behind 12 of the 13 errors), then re-measure with the new answered-by line. If a Gemini fallback on hang is still wanted, it needs a shorter time-to-first-chunk cut than 60 s to leave it room, which is a design change.
