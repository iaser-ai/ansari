# apps/whatsapp

The WhatsApp service: a TypeScript port of [`legacy/whatsapp`](../../legacy/whatsapp/) (issue #358). A user writes to
Ansari's WhatsApp number, Meta posts the message to this service, and the service signs the user in with `apps/auth`, asks
`apps/api` for the answer, and sends it back through Meta.

```
Meta ──POST /whatsapp/v3──> this service ──token exchange──> apps/auth
                                 │  ▲
                                 │  └── answer ── apps/api (threads + streamed chat)
                                 └──────────────> Meta (reply)
```

Meta gets its HTTP 200 first. Signing in, asking `apps/api` and replying all happen afterwards, so a slow answer never makes
Meta send the same message again.

## Run it

```bash
pnpm install                                   # once, at the repo root
cp apps/whatsapp/.env.example apps/whatsapp/.env
pnpm whatsapp dev                              # restarts on change
```

The service refuses to start unless its configuration is valid, and says which variable is wrong. `.env.example`
documents every variable. With `ENVIRONMENT=development` the three `MOCK_*` switches let it run with no Meta, `apps/auth` or
`apps/api` at all (they are refused anywhere else). It is left out of the root `pnpm dev` on purpose: it needs its own
`.env`, and without one it exits at once.

| Command | What it does |
|---|---|
| `pnpm whatsapp dev` | run from source, restarting on change |
| `pnpm whatsapp build` | bundle to `dist/index.mjs` |
| `pnpm whatsapp start` | run the bundle |
| `pnpm whatsapp test` / `lint` / `typecheck` | the checks CI runs |
| `pnpm whatsapp meta:subscriptions` | operator menu for Meta's webhook subscription (see below) |

### The Meta subscription script

`pnpm whatsapp meta:subscriptions` (`scripts/checkMetaSubscriptions.ts`) is the port of the Python
`check_meta_subscriptions.py`. Run it by hand when messages to the business number stop arriving: it shows which Meta apps
are subscribed to the Messaging account, the token's own app and expiry, and the phone numbers, and can subscribe or
unsubscribe the token's app (each change asks for `yes` first). It reads `META_ACCESS_TOKEN_FROM_SYS_USER` and
`META_MESSAGING_ACCOUNT_ID` from `.env` (or asks; the token is typed hidden) and never prints the token. Options 1 to 4 and 7
only read; 5 and 6 change Meta. It is not part of the service image.

## Which environment answers (prefix routing)

The production WhatsApp number can be subscribed to three Meta apps (production, staging and your local zrok one), so every
message reaches all three. The first characters of a text message decide which environment answers; the others ignore it
(`202`, nothing logged or stored). The check is always on and has no setting.

| `ENVIRONMENT` | Answers | Ignores |
|---|---|---|
| `production` | text with no `!d ` or `!s ` prefix | `!d ` and `!s ` messages |
| `staging` | text starting with `!s ` | everything else |
| `development` | text starting with `!d ` | everything else |

Prefixes are exact (lowercase, with the space). The answering environment cuts the prefix off before the question goes to
apps/api. A message that is not text (image, audio...) has no prefix, so only production answers it. **On staging, testers
must start every message with `!s `.** The Meta side is separate and is not done by this code: the staging and test apps
subscribed to the production WhatsApp account, and each instance's `META_BUSINESS_PHONE_NUMBER_ID` and token pointing at
the production number.

**Upgrading a local `.env`:** `DEPLOYMENT_TYPE` is no longer read and `local` is no longer a value. Replace
`DEPLOYMENT_TYPE="local"` with `ENVIRONMENT="development"`, or the service refuses to start.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | health probe (always 200 once listening; it checks no other service) |
| `GET /whatsapp/v3` | Meta's one-time handshake when the callback URL is saved |
| `POST /whatsapp/v3` | every message and delivery receipt, checked against `X-Hub-Signature-256` |
| `GET /sentry-debug` | fails on purpose to prove errors reach Sentry; not served in production |

The routes are `/whatsapp/v3` where the Python service used `/whatsapp/v2`: Meta's callback URL has to be changed when the
service is switched over.

## Where things are

| Path | What |
|---|---|
| `src/index.ts` | starts everything, handles SIGTERM |
| `src/app.ts` | the routes |
| `src/conversationManager.ts` | what happens to a message: sign in, thread, answer, notices |
| `src/services/` | the three outside services (`apps/auth`, `apps/api`, Meta), each with a real and a mock client |
| `src/webhook/` | reading Meta's payload, the signature check, Meta's reply body |
| `src/formatting/` | markdown to WhatsApp formatting and the 4000-character splitter |
| `src/config.ts` | every environment variable, validated |
| `tests/` | Vitest; no test touches the network |

## Deploy

`Dockerfile` builds from the repo root (`docker build -f apps/whatsapp/Dockerfile .`) and `railway.toml` records the Railway
settings. Railway reads its settings from the dashboard, not that file; keep the two in step. Railway sets `PORT` itself.

## Behaviour that differs from the Python service

The port keeps the Python behaviour except where a header comment in the code says otherwise. The main differences are the
route version above, three formatting and splitting bugs fixed on purpose (see `src/formatting/`), a stricter reading of
true/false settings (`true`, `false`, `True`, `False`, `1`, `0` only), and no trace sampling in Sentry.
