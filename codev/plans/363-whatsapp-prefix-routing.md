# PIR Plan: WhatsApp prefix routing, and the environment variable named like the other apps

Issue: iaser-ai/ansari#363. Related: #362, #387.

## Understanding

The production WhatsApp number will be subscribed to three Meta apps (production, staging, and the developer's local/zrok app), so every user message reaches all three environments. A prefix at the start of a text message decides which one answers:

| Environment | Answers | Ignores |
|---|---|---|
| production | text with no `!d ` or `!s ` prefix | `!d ` and `!s ` |
| staging | `!s ` | everything else |
| development (today's `local`) | `!d ` | everything else |

Decided with the owner (2026-11-14):
- Always on, no setting. Staging starts answering only `!s ` messages the moment this deploys, so testers must start every staging message with `!s `.
- The answering instance strips the prefix before the message goes to apps/api, so the answer is not about "!s". Today `!d ` is not stripped.
- The environment names follow the rest of the repo: `apps/api` and `apps/auth` use `development`, `staging` and `production`, and `local` appears nowhere outside `legacy/whatsapp`.
- The variable is renamed from `DEPLOYMENT_TYPE` to `ENVIRONMENT`, like `apps/api` and `apps/auth`.

Checked, not assumed:
- The `!d ` filter is a staging-only check in `app/main.py` (lines 353 to 363). It runs after the maintenance check, and it does not strip anything: `handle_text_message` reads `self.incoming_msg_body["body"]` as is (`whatsapp_conversation_manager.py:321`).
- `local` is tested in `config.py` (mock refusal, log level, `ORIGINS`), `main.py` (Sentry off, uvicorn host and reload), and `app_logger.py` (readable logs). `development` is today only an allowed value and a readable-logs case. Nothing else depends on it.
- `ENVIRONMENT` is **already set** on the Railway `whatsapp` services (`staging` on staging, `production` on the production service), next to `DEPLOYMENT_TYPE`. The Python code does not read it today (a search of `legacy/whatsapp` found no use). Its values are the same as the new names, which is why the rename can be done without changing Railway.
- The production `whatsapp` service has `DEPLOYMENT_TYPE=staging` while `ENVIRONMENT=production`. After the rename, that service would read `ENVIRONMENT=production` and turn production behavior on. That is the intended value, but it is a visible change for that service.

## Proposed Change

Two commits, so the second can be dropped without losing the first.

**1. Prefix routing (keeps `DEPLOYMENT_TYPE`, `local` and `development` as they are).**
- A small function in `app/main.py` (or a helper beside it) that takes the environment and the text of a text message and returns "answer", "ignore" and the text with the prefix removed. Rules as in the table. A prefix is exact: lowercase, with the trailing space, as `!d ` is today.
- It runs **before** the maintenance check. Otherwise, when maintenance is on, an environment that ignores a message would still send its own maintenance notice, and a user would get three.
- Ignoring reuses the existing `DEV_FILTER` reply (202) so Meta gets what it gets today. It logs one generic debug line, with no phone number, BSUID or text.
- Non-text messages have no prefix: production answers them as today, and staging and development ignore them.
- The answering instance replaces `incoming_msg_body["body"]` with the stripped text before the conversation manager is built, so the text goes to apps/api without the prefix.
- Under the old names, the table reads `development` as today's `local` for this commit, so the tests do not change in the second.

**2. Rename (separate and droppable).**
- `local` becomes `development`, and the old `development` value disappears: allowed values are `development | staging | production`. `local` is removed, not kept as an alias, so an old `.env` fails at startup instead of silently misbehaving.
- `DEPLOYMENT_TYPE` becomes `ENVIRONMENT`, with the same allowed values. `DEPLOYMENT_TYPE` is not read after this, so a leftover `DEPLOYMENT_TYPE` in an `.env` is ignored and `ENVIRONMENT` is then required.
- Railway: the `whatsapp` services already have `ENVIRONMENT` set to the right values. The unused `DEPLOYMENT_TYPE` variables can be removed after the deploy. The production service's `DEPLOYMENT_TYPE=staging` goes away with it.

## Files to Change

Commit 1:
- `legacy/whatsapp/src/ansari_whatsapp/app/main.py` (the new function and its use, in place of lines 353 to 363, and moved before the maintenance check at line 337)
- `legacy/whatsapp/tests/test_environment_behaviour.py` (the `!d ` tests become a table over environment x message)
- `legacy/whatsapp/README.md`, `RELEASE.md` (the staging tester rule: start every message with `!s `)

Commit 2:
- `legacy/whatsapp/src/ansari_whatsapp/utils/config.py` (field name, allowed values, the `local` checks, the `ORIGINS` rule, messages)
- `legacy/whatsapp/src/ansari_whatsapp/app/main.py` (Sentry condition, `/sentry-debug`, uvicorn host and reload)
- `legacy/whatsapp/src/ansari_whatsapp/services/meta_api_service_real.py` (the request-details rule for Meta errors)
- `legacy/whatsapp/src/ansari_whatsapp/utils/app_logger.py` (readable logs)
- `legacy/whatsapp/tests/*.py` (conftest and every `DEPLOYMENT_TYPE`/`local` parametrize)
- `legacy/whatsapp/.env.example`, `README.md`, `RELEASE.md`, `codev/resources/arch.md`

## Risks & Alternatives Considered

- Risk: staging stops answering ordinary messages from the Meta test number once this is deployed. Accepted by the owner. The owner tells Amr and any tester to start messages with `!s `.
- Risk: while the production number is not yet subscribed to the staging app, nobody can use `!s ` on the production number. The prefix rule on its own is harmless: staging and development simply answer less.
- Risk: real users' messages reach staging and development and are ignored. The code must not log or store them. Tested.
- Risk: the rename breaks every existing `.env` (the owner's local one, and anyone else's) at startup, with a clear error. The `.env` change is listed in the README and the PR.
- Risk: the Meta-side steps are outside the code and not verified here. The staging and test apps must be subscribed to the production WhatsApp account (today only the production app is). The staging instance's phone number id and token must point at the production number, or it ignores those webhooks as "another number". The owner believes the staging app's token can see the production account.
- Risk: the Sentry environment tag. `main.py` passes the setting's value to Sentry as the environment, so after the rename the production service's events switch from `staging` to `production`. Intended.
- Alternative: a setting that switches prefix routing on (default off). Rejected by the owner.
- Alternative: only remove the old `development` value and keep `local`. Rejected by the owner, who prefers the names the other apps use.
- Alternative: keep `DEPLOYMENT_TYPE`. Rejected by the owner, to match the other apps' `ENVIRONMENT`.
- Alternative: do both renames and the routing in one commit. Rejected: two commits keep each reviewable and droppable.

## Test Plan

- Unit tests for commit 1 (`legacy/whatsapp/tests`): a table over environment (production, staging, development) x message (no prefix, `!d `, `!s `, a non-text type) giving answer or ignore; a test that the answered text reaches apps/api without the prefix; a test that an ignored message does not trigger the maintenance notice when `WA_MAINTENANCE_MODE` is on; a test that an ignored message logs no phone number, BSUID or text.
- Unit tests for commit 2: `local` is refused and `development` behaves as `local` did (mocks allowed, readable logs, DEBUG, phone replies allowed); `ENVIRONMENT` is required and `DEPLOYMENT_TYPE` is not read.
- Every new test is proved to fail: break the code, see it fail, restore.
- Manual, at `dev-approval`: run the service locally with a script (not `afx dev`, which may not work on Windows) and post signed sample webhooks for each environment x message combination; check the 202 or 200 replies and the logs. No Meta or Railway change is made here.
- Not covered here (needs the owner and Meta): the production number's subscription to the staging and test apps, and a real message from a phone to each environment.

## Decisions from the reviewer (2026-11-14)

- `development` is for zrok and local development only. No Railway service is expected to use it, so Railway keeps `staging` and `production`.
- The old `DEPLOYMENT_TYPE` variables on Railway are removed right after the deploy that contains commit 2.
- The plan is approved as written.
