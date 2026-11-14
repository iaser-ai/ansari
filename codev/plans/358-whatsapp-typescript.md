# Plan: Translate the WhatsApp service to TypeScript

**Specification**: [codev/specs/358-whatsapp-typescript.md](../specs/358-whatsapp-typescript.md)

## Executive Summary

A new app, `apps/whatsapp`, re-implements the Python service in `legacy/whatsapp` with the same externally visible behaviour. `legacy/whatsapp` stays untouched as the behavioural reference until staging is verified (spec: no production migration in this issue).

The Python tests (197) are the oracle: each phase ports one layer bottom-up, together with the tests for that layer, so every phase ends green and nothing is written without a test that can fail.

### Stack, chosen to match `apps/auth` (the closest sibling)

| Concern | Choice | Python counterpart | Why |
|---|---|---|---|
| Runtime | Node.js >= 22.18 | CPython 3.13 | Same engine as `apps/auth`; `engines` and the Docker base image are already settled |
| HTTP framework | Express 5 | FastAPI | Already used by `apps/auth`; small, well known |
| Runtime validation | Zod 4 | Pydantic | Already used by `apps/api` and `packages/auth` |
| Outbound HTTP | Node's built-in `fetch` | httpx | No extra dependency; supports streamed bodies |
| Tests | Vitest | pytest | Same as every other app |
| Dev / build | `tsx` / `tsdown` | `uvicorn` / none | Same as `apps/auth` |
| Errors | `@sentry/node` | `sentry-sdk` | Same as `apps/auth` |
| Logging | Small in-app JSON logger with the masking rules ported from `log_masking.py` | loguru + `log_masking.py` | Masking is behaviour we must keep exactly; a library would not remove that work |
| Markdown to WhatsApp text | Port the 99-line formatter by hand | `whatsapp_message_formatter.py` | Exact output must match the Python tests; a library would change it |

### TypeScript notes for the reader (Python to TypeScript)

- **Types vanish at runtime.** `type Foo = {...}` is checked by the compiler, then erased. A JSON body from Meta is `unknown` until a Zod schema parses it. This is the TypeScript counterpart of a Pydantic model, with one difference: Pydantic validates automatically, Zod only when you call `.parse()`/`.safeParse()`.
- **`async`/`await` and Promises.** Same keywords as Python, but a Promise starts running immediately when created (a Python coroutine does not run until awaited). The "answer Meta 200 first, then process" pattern is therefore just `res.sendStatus(200)` followed by an un-awaited call whose failures we catch ourselves: an un-awaited Promise that rejects crashes or goes unnoticed, so every background task gets a top-level `.catch` that logs and reports to Sentry.
- **Streams.** `fetch` returns `response.body`, a web `ReadableStream` of byte chunks. We read it with `for await`, decode with `TextDecoder` (chunk boundaries can split a multi-byte character, so decode with `{stream: true}`), then apply the same aggregation as the Python client.
- **Modules.** `package.json` has `"type": "module"`, so files use `import`/`export` (not `require`). Local imports end in `.ts`/`.js` according to the repo's tsconfig; follow `apps/auth`.
- **`null` vs `undefined`.** Both mean "no value"; JSON only has `null`. The code uses `undefined` for "absent" and `null` only when a wire format says so.
- **Config.** There is no Pydantic `BaseSettings`; a Zod schema parses `process.env` once at startup and exports a frozen object. All values arrive as strings, so booleans and numbers need explicit parsing (`"False"` is a truthy string).
- **Dependency injection.** FastAPI uses `Depends`; here the services are plain objects created in one `buildApp(deps)` function, so tests pass mock clients instead of patching modules (the base/real/mock trio becomes one interface plus a real and a mock implementation).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Scaffold apps/whatsapp, config, masked logging"},
    {"id": "phase_2", "title": "Pure logic: formatter, splitter, webhook parser, language and time helpers"},
    {"id": "phase_3", "title": "Service clients: apps/auth exchange, apps/api streaming, Meta API"},
    {"id": "phase_4", "title": "Conversation manager"},
    {"id": "phase_5", "title": "HTTP app: webhook verification, signature check, immediate 200"},
    {"id": "phase_6", "title": "Docker, Railway config, CI, turbo and documentation"},
    {"id": "phase_7", "title": "Operator script port, staging redeploy, smoke test and legacy rollback note"}
  ]
}
```

**The green command for every phase**, run from the worktree root: `pnpm --filter ansari-whatsapp test && pnpm --filter ansari-whatsapp typecheck && pnpm --filter ansari-whatsapp lint`. Phase 6 widens it to the root `pnpm test && pnpm typecheck && pnpm lint`. Each phase is one commit prefixed `[Spec 358][Phase: ...]`, adding files by explicit path (never `git add -A`).

**Test discipline (from the repo's lessons):** every new test must be shown able to fail by temporarily breaking the code it covers, then restoring it. The Python mapping is recorded per phase.

**Comment discipline (success criterion):** carry over the Python docstrings and comments, with Meta reference URLs, as TSDoc (`/** ... */`). Every setting in `.env.example` and in the config module documents purpose, allowed values, default and which environments use it.

## Phase Breakdown

### Phase 1: Scaffold apps/whatsapp, config, masked logging

**Dependencies**: None

**Objective**: A buildable, testable empty app that loads and validates configuration and logs safely.

**Files to create** (modelled on `apps/auth`): `package.json` (name `ansari-whatsapp`, `"type": "module"`, same scripts), `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `tsdown.config.ts`, `.env.example`, `.env.ci`, `src/config.ts`, `src/logger.ts`, `src/logMasking.ts`, `src/errors.ts`, `tests/config.test.ts`, `tests/logMasking.test.ts`.

**Behaviour to port**: every setting of `utils/config.py` (same names, so Railway variables carry over unchanged): `BACKEND_SERVER_URL`, `AUTH_SERVER_URL`, `AUTH_WHATSAPP_API_KEY`, `META_API_VERSION`, `META_BUSINESS_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN_FROM_SYS_USER`, `META_WEBHOOK_VERIFY_TOKEN`, `META_ANSARI_APP_SECRET` (no default, on purpose), `META_REPLY_BY_PHONE`, `DEPLOYMENT_TYPE` (local, development, staging, production), `ALWAYS_RETURN_OK_TO_META`, `ORIGINS` (CORS), `WA_MAINTENANCE_MODE`, `WHATSAPP_CHAT_RETENTION_HOURS`, `WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS`, `LOGGING_LEVEL`, `SENTRY_DSN`, and the mock flags `MOCK_ANSARI_CLIENT`, `MOCK_AUTH_CLIENT`, `MOCK_AUTH_TOKEN`, `MOCK_META_API`. Secrets are held so they never print (the counterpart of Pydantic's `SecretStr`). Switches accept the same spellings as apps/api's `MAINTENANCE_MODE` (`true`, `false`, `True`, `False`, `1`, `0`; owner decision) and refuse anything else, so `yes`, `on` and `TRUE`, which Pydantic accepted, now stop start-up; phase 7 checks the Railway values. The entry points are named like apps/api's (`getEnv`, `resetEnvCache`, type `Env`), with `buildConfig(env)` added so tests pass an object instead of patching `process.env`. **`LOG_TEST_FILES_ONLY` is deliberately not ported** (owner decision): in Python it silenced every log line not coming from a test file, which was only a way to quiet the test output; the Node test runner already hides logs from passing tests, and Node cannot cheaply see the calling file. **`META_WEBHOOK_ZROK_SHARE_TOKEN` is deliberately not ported** (owner decision): in Python it is read only by `config.py`, to add `<token>.share.zrok.io` to the CORS allow-list in local mode, and Meta's server-to-server webhooks send no `Origin` header, so that entry has no functional effect. Its setup notes (the zrok reserve/release steps and callback-URL explanation) move into `.env.example` as commented-out information so local developers keep them. The rule that `META_REPLY_BY_PHONE` is off by default and refused when `DEPLOYMENT_TYPE` is production; `utils/log_masking.py` and `app_logger.py` (per-environment detail: local full, staging masked, production keys only; request ID and user ID on every line).

**Python tests mapped**: `test_environment_behaviour.py`, `test_railway_logging.py`, part of `test_meta_sender_logging.py`.

**Done when**: green command passes; `.env.example` documents every setting; a negative control proves the production refusal and the masking tests can fail.

### Phase 2: Pure logic

**Dependencies**: Phase 1

**Objective**: The side-effect-free pieces, easiest to verify against Python.

**Files**: `src/formatting/whatsappMessageFormatter.ts`, `src/formatting/messageSplitter.ts`, `src/webhook/parseWebhook.ts` (Zod schema plus extraction; reads `from` only when `META_REPLY_BY_PHONE` is on, read at call time, not at import), `src/utils/language.ts`, `src/utils/time.ts` and matching tests.

**Python tests mapped**: `test_message_splitter.py`, formatter and webhook-parser cases in `test_whatsapp_service.py`, `test_meta_sender_logging.py`.

**Done when**: all mapped cases pass with identical expected strings, including the 4000-character split, RTL handling, status/wrong-number/unsupported/stale webhook classification.

**Deliberate differences from Python (owner decision, 2026-11-10)**: the Python formatter and splitter had three bugs that the port fixes instead of copying. Each is pinned by a test that shows Python's answer beside the new one.
- A lone `*` beside a space is not an italic marker: `2 * 3 and 4 * 5` stays as written (Python: `2 _ 3 and 4 _ 5`) and a `* item` list keeps its bullets (Python: `_ item`).
- `***text***` becomes `*_text_*` (Python: a stray `**text**`).
- A reply with nothing but whitespace gives an empty list from `splitMessage` (Python: no pieces for newlines, pieces of spaces for spaces, which WhatsApp rejects). **Phase 4 must treat an empty list as "nothing to send" and send the user the same "couldn't process your message" notice as for an empty answer**, not stay silent.

### Phase 3: Service clients

**Dependencies**: Phase 2

**Objective**: The three outbound clients, each behind an interface with a real and a mock implementation.

**Files**: `src/services/authClient.ts` (`POST /api/whatsapp/session`, per-BSUID token cache for a little under 15 minutes, the 400/401/403/429+`X-Retry-After`/500 handling and per-user cool-down from spec 321), `src/services/ansariClient.ts` (streaming chat endpoints, trailing `Error:` detection after HTTP 200, 401 then one re-exchange and one retry), `src/services/metaApiService.ts` (typing indicator, send; `reply_to` BSUID or phone), mocks, tests using a local fake HTTP server or injected `fetch`.

**Python tests mapped**: `test_auth_statuses.py`, `test_bsuid_auth_flow.py`, client parts of `test_thread_lifecycle.py`.

**Done when**: the status table in spec 321 is fully covered, including: no phone number ever in an `apps/auth` or `apps/api` request body or log; a second 401 ends with the right Sentry event name.

### Phase 4: Conversation manager

**Dependencies**: Phase 3

**Objective**: The orchestration: user registration via token exchange, the thread lifecycle (one thread per user, 3-hour expiry), maintenance mode (`WA_MAINTENANCE_MODE`), the staging `!d ` prefix filter, message-age check, notices.

**Files**: `src/conversationManager.ts`, `tests/conversationManager.test.ts`.

**Python tests mapped**: `test_thread_lifecycle.py`, orchestration parts of `test_whatsapp_service.py`, `test_bsuid_auth_flow.py`.

**Done when**: all Python lifecycle and notice scenarios pass; negative controls for expiry, maintenance and the `!d ` filter.

### Phase 5: HTTP app

**Dependencies**: Phase 4

**Objective**: The Express app and server entry.

**Files**: `src/app.ts` (`buildApp(deps)`), `src/index.ts`, `tests/app.test.ts`. Routes: `GET /` health, `GET /whatsapp/v3` verification handshake, `POST /whatsapp/v3`. The signature check needs the raw request bytes, so the JSON body parser must keep them (Express `express.json({ verify })`) and the HMAC-SHA256 comparison must be constant-time (`crypto.timingSafeEqual`). The handler responds 200, then runs processing un-awaited with a top-level catch. Request-ID middleware; `ALWAYS_RETURN_OK_TO_META` behaviour preserved, including the unsupported-message path (error code `UNSUPPORTED_MESSAGE_TYPE`, status 415 when the flag is off); CORS from `ORIGINS`; the verification handshake compares tokens in constant time like `hmac.compare_digest`; graceful shutdown; binds `PORT` (default **3200** for local runs; Railway injects its own `PORT`). Express has no default port (8001 was a choice in the Python service, not a FastAPI rule; 8000 is only uvicorn's default). 3000 is `apps/api`, 3100 is `apps/auth`, and nothing in the repo uses 3200, so the next free number in the same series is used. The local zrok command changes from `localhost:8001` to `localhost:3200`.

**Note on `scripts/check_meta_subscriptions.py`** (644 lines, an operator tool, not part of the service): it is ported separately, in phase 7.

**Python tests mapped**: `test_whatsapp_service.py`, `test_utils.py`.

**Done when**: acknowledgment timing is tested independently of background work (the 200 is observed before a deliberately slow mock finishes); invalid or missing signature rejected; handshake passes and fails correctly.

### Phase 6: Docker, Railway config, CI, turbo and documentation

**Dependencies**: Phase 5

**Objective**: Make the app shippable by the repo's tooling.

**Files**: `apps/whatsapp/Dockerfile` (same shape as `apps/auth/Dockerfile`), `apps/whatsapp/railway.toml` (health check `/`; the same "record, not read by Railway" header as the legacy file), `apps/whatsapp/README.md`, root `turbo.json` `globalEnv` additions for the new variables (the file explains why every variable must be listed), a CI job for the new app, and the architecture notes under `codev/resources/`.

**Done when**: root green command passes from a cold cache (`--force`); Docker image builds locally if Docker is available (otherwise recorded as **not verified**, never as passed).

### Phase 7: Operator script port, staging redeploy, smoke test and legacy rollback note

**Dependencies**: Phase 6

**Why the script is here and not its own phase:** porch fixes the list of plan phases when the plan is approved, so a new numbered phase would need a rollback to the plan phase and a second approval. The script is first in this phase, because the staging steps below use it.

**Part A: port `legacy/whatsapp/scripts/check_meta_subscriptions.py`** (644 lines, an interactive operator tool) to `apps/whatsapp/scripts/checkMetaSubscriptions.ts`. It inspects the Meta Messaging account (WABA): its details, the apps subscribed to it, its phone numbers and the access token's app and expiry, and can subscribe or unsubscribe the app the token belongs to. A webhook only reaches the Meta apps subscribed to the account, so it is the tool for "messages to the staging number do not arrive".
- Same menu, same explanatory text (the prerequisite-knowledge section and the WABA/app/token relations), same confirmations before the two changing actions (POST and DELETE on `subscribed_apps`), same fallback to prompting when `.env` has no token or account id.
- Counterparts: `requests` becomes the built-in `fetch`; `input()` and `getpass` become `node:readline/promises` (the token prompt hides what is typed); `load_dotenv` becomes `dotenv`. Reads `META_ACCESS_TOKEN_FROM_SYS_USER`, `META_MESSAGING_ACCOUNT_ID` and `META_API_VERSION` (Python hard-coded `v26.0`; same default here). Run with `pnpm --filter ansari-whatsapp meta:subscriptions`.
- The Python script has no tests. The TypeScript one gets tests for its pure parts with an injected `fetch`: how each Meta response is read, that only the token's own app is ever unsubscribed, and that the token is never printed. Each is shown able to fail.
- `.env.example`: the commented `META_MESSAGING_ACCOUNT_ID` and `META_ANSARI_APP_ID` entries now say this script reads them.
- **Verified** only against mocked responses. Live checks (read-only options) run against staging in Part B. The two changing actions are not run without the owner's go-ahead.

**Part B: staging.** Replace the Python build on the existing Railway staging `whatsapp` service. No production change.

**Steps**:
1. Compare the staging service's variables with `.env.example` (names only; never print values or the token `ASH_RAILWAY_PAT`). Also check that every True/False variable uses `true`, `false`, `True`, `False`, `1` or `0`: the TypeScript service refuses `yes`, `on` and `TRUE`, which the Python service accepted.
2. Point the staging `whatsapp` service at `apps/whatsapp/Dockerfile` and redeploy. **Done by the user or with the user's explicit go-ahead**, because it changes a shared service.
3. Smoke test: visible-phone user, hidden-phone (BSUID-only) user, a long answer, and error paths (maintenance mode, `apps/auth` refusal).
3a. Change the webhook callback URL in the staging Meta app's webhook settings from `.../whatsapp/v2` to `.../whatsapp/v3` (owner-made change in Meta's dashboard; re-run the verification handshake and confirm Meta shows the subscription as active). Until this is done, Meta still posts to `/v2`, which the TypeScript service does not serve.
4. Add a brief rollback note to `legacy/whatsapp/README.md` (rolling back also means setting Meta's callback URL back to `/whatsapp/v2`): the Python image and Dockerfile are unchanged, so rollback is repointing the staging service at `legacy/whatsapp/Dockerfile` and redeploying.

**Done when**: smoke results are listed in the review as verified or not, with evidence.

## Addendum: issue #363 (prefix routing and the `ENVIRONMENT` rename), added after phase 7

The Python service gets the same two changes separately (PIR #363, `builder/pir-363`); the two must behave the same. Not a new plan phase (porch fixes the phase list at plan approval); it is extra commits on this branch, before the PR.

- **Prefix routing** (`ConversationManager.triage`, before the maintenance check): production answers text with no `!d `/`!s ` prefix; staging only `!s `; development only `!d `. Exact prefixes. Non-text has no prefix, so only production answers it. Ignored messages reuse `dev_filter` (202), log one generic debug line and are never stored. The answering instance strips the prefix before apps/api. Always on, no setting.
- **Rename**, a separate and last commit so it can be dropped alone: `DEPLOYMENT_TYPE` becomes `ENVIRONMENT` with `development | staging | production`; `local` is removed with no alias and `DEPLOYMENT_TYPE` is no longer read. `development` keeps what `local` meant (mocks, readable logs, DEBUG, phone replies, full 400 body in Meta error logs). Nothing in `apps/whatsapp` used the name `ENVIRONMENT` before (searched). Railway already sets `ENVIRONMENT` on the whatsapp services, so no Railway change is needed.
- **Tests:** an environment x message table, strip, maintenance order and no-logging tests; for the rename, `local` refused, `development` behaving as `local` did, `ENVIRONMENT` required. Each shown able to fail by breaking the code and restoring it.
- **Not covered by code (Meta side):** the staging and test apps subscribed to the production WhatsApp account, and each instance's phone number id and token pointing at the production number. On staging, testers must start every message with `!s `.

## Risks and Mitigation

| Risk | Mitigation |
|---|---|
| Acknowledgment delayed by processing | Phase 5 timing test |
| Types give false confidence about Meta JSON | Zod parsing at every boundary (phases 2, 3) |
| Streaming aggregation differs from Python | Chunk-boundary and trailing-error tests (phase 3) |
| Formatter output drifts | Port Python expectations verbatim before refactoring (phase 2) |
| Un-awaited background Promise fails silently | Single wrapper with catch, log and Sentry; test that a failure is reported (phase 5) |
| Windows test flakiness (CRLF fixtures, POSIX paths) | No fixture files read from disk; paths built with `node:path` |

## Self-review (agent, no external consultation)

The owner chose agent self-review followed by owner review; Codex and Gemini are not installed and the Claude consult hung. Checked against the Python source:

- **Fixed:** the plan omitted the CORS `ORIGINS` setting, the four mock flags, the 415 unsupported-message reply, and the default port (now 3200, not Python's 8001).
- **Decided:** `META_WEBHOOK_ZROK_SHARE_TOKEN` is not ported; its notes live in `.env.example` as comments. Verified by search: the only code reading it is `config.py`; the other mentions are docs, `.env.example`, the README and printed hints in `check_meta_subscriptions.py`. Not verified live: that Meta never sends an `Origin` header (inferred from webhooks being server-to-server and from the code only checking `Origin`).
- **Fixed:** settings must keep their Python names so Railway staging needs no variable changes.
- **Verified:** route list (`GET /`, `GET /whatsapp/v2`, `POST /whatsapp/v2`) and the constant-time token and signature comparison match `main.py`. The TypeScript service deliberately renames the two webhook routes to `/whatsapp/v3` (owner decision), so the port is not byte-for-byte identical there.
- **Changed after owner review of phase 1:** booleans use apps/api's six spellings; `getEnv`, `resetEnvCache` and `Env` replace `getConfig`, `resetConfigCache` and `Config`; `LOG_TEST_FILES_ONLY` is dropped; the Meta script is ported in phase 7.
- **Not verified:** exact Markdown formatter output and splitter edge cases are only confirmed once the Python tests are ported (phase 2).
- **Not verified:** whether `apps/auth`'s tsconfig and eslint presets apply unchanged to a second Express app; phase 1 finds out.

## Open items for the owner

- Confirm the directory name `apps/whatsapp` (the spec said "likely").
- Staging variable changes and the Railway repoint in phase 7 need the owner's go-ahead at that time.
