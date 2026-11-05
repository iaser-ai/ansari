# Rebuttal: auth_token_exchange, iteration 1

Review: `321-auth_token_exchange-iter1-claude.txt` (COMMENT). Findings 1 to 4 are accepted and fixed; 5 and 6 are accepted and recorded in the plan for Phase 4.

1. **`get_subject()` could raise.** Fixed: it now also catches `AttributeError` and `TypeError`. A test with a payload that is valid JSON but not an object fails without the fix (`'int' object has no attribute 'get'`) and passes with it.
2. **Token exchange timeout.** Fixed: lowered from 15 s to 5 s, matching the window Meta expects. Moving authentication into the background task was not done: an auth failure would then no longer be reported in the webhook response, which the existing error handling relies on.
3. **Typing indicator never cancelled on failure.** Fixed: it is now scheduled only for text messages the user is signed in for, right before `handle_text_message`, the one place that cancels it. This also covers the too-old and unsupported-type returns.
4. **apps/api half of the "no phone number" criterion.** Fixed: a new test runs the full webhook flow against the real client over a mock transport, and asserts that none of the three requests (list threads, create thread, send message) contains the phone number or the BSUID. It fails when a phone number is deliberately added to a request body.
5. **Inline `Error:` text relayed to the user.** Accepted, not fixed here: detecting the trailing sentinel is brittle, and the proper fix touches answer handling. Added to Phase 4 in the plan.
6. **`from_user_id` requirement and untested BSUID send.** Accepted, recorded as a deploy blocker in Phase 4 of the plan, to be checked before the staging smoke test.
7. **Minor.** The `README.md` still documents the removed endpoints, which Phase 4 already owns; noted there. Not changed: the unused `close()` methods are pre-existing, and the failure-notice test keeps its name, because the "reported" half is the Meta error code returned to the caller.

Verification: ruff clean, 24 tests pass, with both new red-path checks shown to fail first. Not proven: nothing has run against a live `apps/auth` or `apps/api`, since the `/whatsapp` endpoint does not exist yet.
