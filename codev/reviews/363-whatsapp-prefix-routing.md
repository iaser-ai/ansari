# PIR Review: WhatsApp prefix routing, and the environment named like the other apps

Fixes #363

## Summary

One real WhatsApp number now feeds production, staging and a developer's machine. Every copy of the service receives every message, and each answers only its own: no prefix is production's, `!s ` is staging's, `!d ` is development's. The answering copy drops the prefix before the text reaches `apps/api`. In a second, separate commit the environment setting is renamed to match `apps/api` and `apps/auth`: `DEPLOYMENT_TYPE` becomes `ENVIRONMENT`, with the values `development`, `staging` and `production` (`local` is removed).

## Files Changed

- `RELEASE.md` (+4 / -2)
- `codev/resources/arch.md` (+1 / -1)
- `legacy/whatsapp/.env.example` (+4 / -4)
- `legacy/whatsapp/README.md` (+10 / -10)
- `legacy/whatsapp/src/ansari_whatsapp/app/main.py` (+26 / -31)
- `legacy/whatsapp/src/ansari_whatsapp/services/meta_api_service_real.py` (+4 / -4)
- `legacy/whatsapp/src/ansari_whatsapp/utils/app_logger.py` (+5 / -5)
- `legacy/whatsapp/src/ansari_whatsapp/utils/config.py` (+14 / -14)
- `legacy/whatsapp/src/ansari_whatsapp/utils/prefix_routing.py` (+28 / -0)
- `legacy/whatsapp/src/ansari_whatsapp/utils/whatsapp_webhook_utils.py` (+1 / -1)
- `legacy/whatsapp/tests/README.md` (+1 / -1)
- `legacy/whatsapp/tests/conftest.py` (+19 / -1)
- `legacy/whatsapp/tests/test_bsuid_auth_flow.py` (+16 / -23)
- `legacy/whatsapp/tests/test_environment_behaviour.py` (+197 / -38)
- `legacy/whatsapp/tests/test_meta_sender_logging.py` (+20 / -21)
- `legacy/whatsapp/tests/test_railway_logging.py` (+4 / -5)

## Commits

- `cd2d8016` [PIR #363][Phase: implement] refactor: name the environment like apps/api and apps/auth (ENVIRONMENT: development | staging | production)
- `396e62b3` [PIR #363][Phase: implement] feat: answer only messages meant for this environment (!s staging, !d local, none production) and drop the prefix
- `9f3f9107` [PIR #363] Plan revised: reviewer decisions
- `3b7ea258` [PIR #363] Plan draft

## Test Results

- Build check (porch override for a Python-only change): format check and `compileall` in `legacy/whatsapp`: pass
- Tests: `uv run pytest tests` in `legacy/whatsapp`: 214 passed (197 before; the routing and rename tests are new or rewritten), `ruff check` clean
- Negative controls: 14 deliberate breakages across both commits (prefix not stripped, staging answering everything, production answering prefixed messages, non-text always answered, prefix not exact, routing after the maintenance check, ignored message logged, `local` accepted again, mocks allowed in staging, phone replies allowed in production, debug level, JSON logs, body logging, development prefix): the suite failed each time. One test (`local` refused) did not fail at first, so it was corrected and re-checked
- Manual verification: the real service was started as production, staging and development on a local port, and signed sample webhooks were posted over HTTP. Production answered only the unprefixed message, staging only `!s `, development only `!d `, and every other combination returned 202 `DEV_FILTER`. Production and staging used real clients, so only Meta's reply was checked, nothing downstream
- Not tested: anything against Meta, and the Railway and Meta steps listed below

## Architecture Updates

Cold tier only: `codev/resources/arch.md` (the WhatsApp service paragraph) now describes the prefix routing, and says mocks are refused outside `ENVIRONMENT=development`. No hot-tier change: the routing is local to the WhatsApp service and not a cross-cutting fact for other modules.

## Lessons Learned Updates

No lessons captured for the repo's docs. Two notes for the Windows setup went into the `ansari-ash-codev` skill instead (outside this repo): a Python-only change fails porch's stock build check and needs an override, and `porch done` must not be chained with `porch gate`.

## Things to Look At During PR Review

- The prefix check runs **before** the maintenance check on purpose. Otherwise, in maintenance mode, each of the three copies would send its own notice for one message.
- Non-text messages (images and so on) carry no prefix, so only production handles them; staging and development ignore them.
- The test suite starts as `development` (the only value that may switch mocks on), and an autouse fixture in `tests/conftest.py` then sets `production` so plain messages are answered. Setting the value after start-up skips the mock refusal, so the fixture must stay narrow.
- The rename is its own commit (`cd2d8016`) and can be dropped without losing the routing. `DEPLOYMENT_TYPE` is no longer read, and `local` is refused with a clear error.
- `ENVIRONMENT` was already set on the Railway `whatsapp` services (`staging` and `production`), so the rename needs no Railway change. Sentry's environment tag for the production service changes from `staging` to `production`, which is intended.

## How to Test Locally

- **View diff**: `git diff upstream/develop...builder/pir-363`
- **Run the tests**: from `legacy/whatsapp`, `uv run pytest tests -q`
- **What to verify**: run the service with `ENVIRONMENT=development` and the three mock switches on, post a signed sample webhook with text `!d hello` (answered), `hello` and `!s hello` (both ignored, 202); then with `ENVIRONMENT=staging`, only `!s hello` is answered. Anyone with a local `.env` must change `DEPLOYMENT_TYPE="local"` to `ENVIRONMENT="development"`.