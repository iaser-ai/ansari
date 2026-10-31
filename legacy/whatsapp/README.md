# legacy/whatsapp

The WhatsApp front door for Ansari. It receives webhooks from Meta, signs the user in through `apps/auth`, and talks to `apps/api` with the resulting token.

## How a message flows

1. Meta posts a webhook to `POST /whatsapp/v2`. The `X-Hub-Signature-256` header is checked against `META_ANSARI_APP_SECRET`, which has no default: the service will not start without it. Meta gets its 200 reply straight away; everything below runs in the background.
2. The user is identified by their BSUID (Meta's per-user id), read from `from_user_id`. The phone number is never read, stored, logged or sent on.
3. `apps/auth` (`POST /api/whatsapp/session`, header `Authorization: Bearer <AUTH_WHATSAPP_API_KEY>`, body `{bsuid}`) returns a token for that user (contract: issue #329). The token is reused for the same user for 14 minutes, a little under its 15-minute life.
4. The service finds the user's newest thread in `apps/api` (`GET /api/v2/threads`). If it is older than `WHATSAPP_CHAT_RETENTION_HOURS` it is deleted and a new one is created (`source: "whatsapp"`).
5. The message goes to `POST /api/v2/threads/{id}/chat`. The server-sent-event stream is collected and the answer is sent back to the user's BSUID, split to fit WhatsApp's 4,000-character limit.

If sign-in fails, the user is told, and Meta still gets its 200, because sign-in runs after the reply. What the user is told and what reaches Sentry depend on why it failed:

| pps/auth answered | Meaning | User is told | Sentry error_type |
|---|---|---|---|
| 400 | Our request was malformed (a bug here) | Sign-in failed | uth_bad_request |
| 401 | Our API key is bad: needs an operator | Sign-in failed | uth_key_rejected |
| 403 | The user is banned | The account cannot be answered | none (log only) |
| 429 | The user's budget is spent (6 per 15 minutes) | To wait about X-Retry-After | none (log only); the user is not asked again until it ends |
| 500 or no answer | An outage, or a fault for this one user | Sign-in failed | uth_token_failure |

None of these is retried per message. If pps/api itself answers 401 to a cached token (the session ended after the token was signed, for example a ban), the service drops that token, exchanges once more and retries the message once; a second 401 gives up with pi_unauthorized_after_reexchange.

## Layout

```
src/ansari_whatsapp/
  app/main.py        FastAPI app: health check, webhook verification, webhook handler
  services/          conversation manager; apps/api, apps/auth and Meta clients (base / real / mock)
  presenters/        formatting for WhatsApp (markdown to text, right-to-left, splitting)
  utils/             config, JSON logging, webhook parsing, time helpers
```

## Run locally

Use `uv`, not `pip`.

```powershell
cd legacy/whatsapp
copy .env.example .env      # then fill it in
uv sync
uv run python src/ansari_whatsapp/app/main.py
```

The service listens on `PORT` (default `8001`). With `MOCK_ANSARI_CLIENT=True`, `MOCK_AUTH_CLIENT=True` and `MOCK_META_API=True` it needs none of the other services.

### Receiving real webhooks locally

Meta needs a public URL. A reserved zrok share forwards one to your machine:

```powershell
zrok reserve public localhost:8001 -n <META_WEBHOOK_ZROK_SHARE_TOKEN>
```

The matching callback URL (`https://<token>.share.zrok.io/whatsapp/v2`) is set on the `Ansari - Test` app in Meta's dashboard. See `.env.example` for who holds the token. Use the credentials of that same app (token, app secret, verify token).

Staging shares the same test number, so start every message you send while testing locally with `!d ` (for example `!d what is ansari?`). Staging ignores those; your local service answers them.

### Test and staging switches

| Behaviour | When |
|---|---|
| Messages starting with `!d ` are ignored, so a developer testing locally on the shared test number does not get answered twice | `DEPLOYMENT_TYPE=staging` |
| Every message gets a "down for maintenance" reply and nothing is processed | `WA_MAINTENANCE_MODE=True` (independent of `apps/api`'s own flag) |
| JSON logs on stdout (otherwise readable logs) | any `DEPLOYMENT_TYPE` except `local` and `development` |
| `GET /sentry-debug` deliberately crashes, to prove errors reach Sentry | every `DEPLOYMENT_TYPE` except `production` |

## Environment variables

`.env.example` is the full, commented list. The ones that matter:

| Variable | Purpose |
|---|---|
| `DEPLOYMENT_TYPE` | `local`, `development`, `staging` or `production` |
| `BACKEND_SERVER_URL` | `apps/api` base URL, no path |
| `AUTH_SERVER_URL` | `apps/auth` base URL, no path |
| `AUTH_WHATSAPP_API_KEY` | API key issued by `apps/auth` for this service, sent as a Bearer token to its WhatsApp sign-in endpoint |
| `META_BUSINESS_PHONE_NUMBER_ID` | Phone number this service answers on; webhooks for other numbers are ignored |
| `META_ACCESS_TOKEN_FROM_SYS_USER` | Meta API token (belongs to one Meta app) |
| `META_ANSARI_APP_SECRET` | Verifies webhook signatures (must be the same app as the token) |
| `META_WEBHOOK_VERIFY_TOKEN` | One-time webhook URL verification |
| `WA_MAINTENANCE_MODE` | See above |
| `WHATSAPP_CHAT_RETENTION_HOURS` | How long a conversation continues before a fresh thread (default 3) |
| `SENTRY_DSN` | Empty disables Sentry |
| `LOGGING_LEVEL` | Optional. Unset means `DEBUG` for `local` and `INFO` everywhere else |
| `MOCK_ANSARI_CLIENT`, `MOCK_AUTH_CLIENT`, `MOCK_META_API` | Replace the real services with fakes. The service refuses to start with any of them unless `DEPLOYMENT_TYPE=local` |
| `MOCK_AUTH_TOKEN` | With `MOCK_AUTH_CLIENT=True`: a real JWT returned for every BSUID, so a real `apps/api` accepts it. Every user would share one account and thread, so it is refused like the other mock switches |

Meta credentials differ per Meta app (Test, Staging, production). A token from one app will not work with another app's secret.

## Tests

```powershell
cd legacy/whatsapp
uv run --with ruff ruff check .
uv run pytest tests -q
```

No network or other service is needed. See [tests/README.md](tests/README.md).

## Logging

In deployed environments each log line is one JSON object on stdout with `message`, `level`, `request_id`, `file`, `line` and `function`, plus `exception` on errors. This is the shape Railway indexes.

In Railway's log search:

- one request: `@request_id:<id>` (the id is also returned in the `X-Request-ID` response header)
- all errors: `@level:error`

Logs deliberately contain no phone numbers, BSUIDs or message text. Railway caps logging at 500 lines per second per replica, and retention depends on the plan.

## Deploying (Railway)

Only the facts below come from this repo. The dashboard settings themselves are set by an operator.

- Build with the repository root as the root directory and `legacy/whatsapp/Dockerfile` as the Dockerfile path. Locally, from the repo root: `docker build -f legacy/whatsapp/Dockerfile -t ansari-whatsapp .`
- `legacy/whatsapp/railway.toml` records these settings in git; Railway does not read it (same as `apps/api/railway.toml`).
- Set a watch path so only changes under `legacy/whatsapp/**` and `.dockerignore` (the build context is the repo root, so that file decides what the build sees) rebuild this service (see the "Railway service configuration" block in `RELEASE.md`).
- Health check path: `/`.
- The app binds `PORT` when Railway provides it. If the public domain is given a fixed target port, it must match.
- Each environment needs its own Meta credentials and its own webhook callback URL (`https://<domain>/whatsapp/v2`).

The Docker image has not been built or run by the author of this change. Do that first when preparing a deploy.

### Staging smoke test

1. `GET /` returns 200.
2. Meta's webhook verification succeeds for the staging callback URL.
3. A normal message gets an answer; a message starting with `!d ` gets no reply from staging.
4. A second message within the retention window continues the same conversation.
5. A message after the retention window starts a new conversation and the old thread is gone from `GET /api/v2/threads`.
6. An answer longer than 4,000 characters arrives as several messages in order.
7. The answer is delivered to a user whose phone number is hidden (BSUID only).
8. With `WA_MAINTENANCE_MODE=True`, the maintenance reply is sent and no chat call appears in `apps/api` logs.
9. `GET /sentry-debug` produces a Sentry event.
10. In Railway's logs, `@request_id:<id>` finds all lines of one message, and none contains a phone number or message text.

### Known gaps to confirm before production

- A real phone's webhook has never reached this service. Meta's dashboard sample webhooks did (signature verified, `from_user_id` present), and one production-number send to a real BSUID was accepted by Meta (HTTP 200, delivery and read statuses followed). That send used a direct HTTP call with the same endpoint and body shape, not `MetaApiServiceReal` itself.
- `apps/auth`'s `/whatsapp` route (issue #329) does not exist yet, so the real sign-in call has never been exercised. The service has run against a real `apps/api` (with a real JWT from `apps/auth` returned by the mock sign-in): a thread was created and the chat stream answered.
- The Docker image has not been built or run.
- `apps/api`'s chat routes save every message with `source: "web"`, so WhatsApp messages are not marked as such in the history.
- Two near-simultaneous first messages from one user can create two threads. Extra `whatsapp` threads are harmless and can be swept manually (keep the newest per user).
