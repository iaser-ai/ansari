# Rebuttal: review phase (PR #327), iteration 2

Review: `321-review-iter2-claude.txt` (COMMENT). All four iteration-1 fixes were confirmed. The reviewer's four new findings are accepted and fixed; nothing is rebutted. Each new test was shown to fail when its fix is undone.

1. **The apps/api error body was logged and sent to Sentry. Accepted, fixed.** `process_message` now logs and raises with only the HTTP status code. Test: a failing `/chat` (the mock body echoes user text) must raise an error that names the status but not the body, and log neither. It fails when the body is put back into the raised error.
2. **The staging `!d ` filter crashed on unsupported message types. Accepted, fixed, and a good catch.** Meta sends an unsupported type as an `errors` list, so `.get` on it raised in staging only, giving a 500 and a Meta retry loop. The filter now looks inside the body only when it is a dict. Test: a staging webhook with an `errors` list gets `UNSUPPORTED_MESSAGE_TYPE` and no chat call. It fails when the guard is removed.
3. **One unredacted payload interpolation. Accepted, fixed.** The missing-`phone_number_id` message now goes through `_redact_for_logging` like the others. No test: it only formats business metadata and nothing reaches it in normal flows; the change is one line.
4. **`"Message too old, notified user"` while nothing notifies the user. Accepted, fixed.** The response text and the docstring now say the message is ignored.

Verification: ruff clean, format clean, 79 passed.
