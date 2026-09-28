# PIR #128 — Rebuttal / Disposition for Review Iteration 1

## gemini — COMMENT

Gemini's lane skipped non-blockingly: the Antigravity `agy` CLI is not
installed in this environment. No verdict to address.

## codex — REQUEST_CHANGES (HIGH confidence)

> `chat-reconcile.ts:140-164` searches the entire rendered history for the
> last matching user message. Before refetch, if the user repeats any
> earlier follow-up text, that historical row is assigned `followUpKey` and
> no synthetic row is appended at the thread foot — reproducing the original
> missing-question bug. Match only `landedFollowUp`/rows added after
> `sentAtCount`; otherwise append the synthetic row. Add a regression test
> for repeating an earlier non-`ECHO_ID` question.

**Real defect — fixed.** Confirmed by tracing the code: the follow-up match
scanned `withEcho` backward for the last `role === 'user'` row with matching
content and `id !== ECHO_ID`, with no lower bound tying it to this turn. A
reader repeating earlier text (e.g. "tell me more" twice) would have that old
row re-keyed to `followUpKey` instead of a new synthetic row being appended —
reproducing #128's exact symptom for that input, and additionally re-keying a
historical row so it reads as new content and re-animates.

**Fix** (`prototypes/ansari-expo/lib/chat-reconcile.ts`, commit `12b6fbd`):
the match is now bound to `landedFollowUp`'s identity — `landedFollowUp` is
itself computed by scanning `serverMessages` from `sentAtCount` forward, so
matching on `landedFollowUp.id` inherits that bound and can never reach a row
older than this turn.

**Regression test added** (`chat-reconcile.test.ts`, "does not re-key an
earlier identical user message when the follow-up repeats old text"): a
thread whose one prior message has the same text as `pendingFollowUp`,
pre-refetch — asserts the old row keeps its own id and a new synthetic row
carrying `followUpKey` is appended instead.

## claude — REQUEST_CHANGES (HIGH confidence)

Same root cause as codex's finding, described in more detail (including the
concrete `matchIndex = -1` walkthrough and the suggested `landedFollowUp`-
identity fix). **Fixed identically** — see above; the shipped fix matches the
shape claude proposed.

Claude's three smaller, non-blocking notes:

1. **`pendingFollowUp` only clears inside `if (streamingText && landedAnswer)`.**
   Correct observation. A turn that lands with empty streamed text (a
   tool-only turn, a refusal) leaves `pendingFollowUp` set until the next
   send. Not fixed: the content/identity match still prevents a duplicate
   row, so this is cosmetically inert — but it is a real asymmetry with
   `streamingText`'s own reset, worth revisiting if a future change makes
   that state observable. Documented in the review file's "Things to Look At".
2. **Retry re-animates the question bubble.** `send(failedQuestion)` bumps
   `turnSeq`, so the retried follow-up gets a fresh `followUpKey` and
   animates in again. Not a bug — a retry is a new turn — but flagged as a
   judgment call, documented in the review file.
3. **Manual verification didn't state which platform(s) were tested.**
   Fair. Only `localhost:8081` (Expo web) was exercised at `dev-approval`,
   not iOS, though the plan's Test Plan calls for both given the
   `FlatList`/`drawn`-gate behaviour this PR touches differs by platform.
   Documented explicitly in the review file's Test Results and "Things to
   Look At", with a recommendation for an iOS pass before/shortly after
   merge — not blocking, but flagged honestly rather than glossed over.

## Note on re-review

Per PIR's single-pass design, this fix has **not** been independently
re-reviewed by a second consultation pass. The correctness backstop is the
regression test above plus the human's review at the `pr` gate — flagged to
the architect accordingly.
