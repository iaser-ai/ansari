# Specification: WhatsApp support in the monorepo

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

Ansari's WhatsApp experience runs on two legacy repositories (`ansari-project/ansari-whatsapp` and `ansari-project/ansari-backend`) that are separate from this monorepo. Nothing in the monorepo handles WhatsApp, so WhatsApp users depend on a stack that is being replaced and cannot share the monorepo's user, thread, message and chat pipeline.

A production issue on 2026-10-17 shows the cost: Meta now lets users hide their phone number behind a WhatsApp username and sends an anonymous business-scoped user ID (BSUID) instead. The legacy service, which identifies users by phone number only, failed on these messages and the users got no reply. An interim notice (ansari-whatsapp#8 / PR #9) exists, and proper support was deferred to this port.

Affected: all WhatsApp users who currently cannot use Ansari on WhatsApp at all; and the maintainers, who must keep two stacks alive.

## Current State

- The legacy WhatsApp service (Python, FastAPI) receives Meta webhooks, verifies Meta's signature, and answers Meta "OK" immediately while processing in the background. It filters wrong-number webhooks, status updates, over-age messages and unsupported message types, shows a typing indicator, and replies through Meta's API.
- Users are identified by phone number and stored in the legacy backend as ordinary users (`source = whatsapp`, phone number, preferred language, no email or password).
- A conversation continues until the user has been silent for 3 hours (global setting), then a new one starts. Old conversations are kept.
- The answer is produced by the legacy backend's streaming chat, collected in full by the service, converted from markdown to WhatsApp formatting and split into messages of at most 4000 characters.
- The service has its own maintenance flag, and a temporary `!d ` message prefix that lets staging ignore messages meant for a developer's local server (staging and local share one Meta test number).
- Each environment (local, staging, production) has its own Meta app credentials.
- In this monorepo, `apps/api` already provides users, threads, messages, the chat pipeline, client attribution, Sentry and a global `MAINTENANCE_MODE`. It does not receive or verify Meta messages, send replies through Meta, or know WhatsApp identities. Authentication is moving to a central service, `apps/auth`, which issues JWTs that `apps/api` verifies; `apps/api` no longer handles passwords or logins.

## Desired State

- WhatsApp is served from this monorepo by a separate WhatsApp service that talks to `apps/api` over HTTP. It begins as the existing Python service, imported as is as much as possible.
- Every WhatsApp user, including phone-hidden users, gets answers. Users are recognised by BSUID only; the phone number is never sent to or stored in this app.
- The WhatsApp service exchanges the user's BSUID for a JWT through a new `/whatsapp` endpoint in `apps/auth`, then calls `apps/api` with the message text and that JWT. `apps/api` identifies the user by the GUID in the JWT, exactly as for other users.
- This app stores only the user's GUID and settings (in the existing `preferences` table), not the BSUID or phone number.
- Each WhatsApp user has exactly one thread, the current conversation. When a message arrives after the expiry time (3 hours, global), the old thread and its messages are deleted and a new thread starts.
- Replies are complete messages (WhatsApp cannot stream), produced by aggregating the existing streaming endpoints and split for WhatsApp, as the legacy service does.
- Meta is always answered "OK" immediately, with no queue or message log table; failures are logged.
- The WhatsApp service has its own maintenance flag, `WA_MAINTENANCE_MODE`, which is independent of `apps/api`'s `MAINTENANCE_MODE`. While it is on, users get a maintenance notice on WhatsApp.
- The `!d ` prefix behaviour for staging is preserved.

## Success Criteria

- [ ] A message from a phone-visible user is answered on WhatsApp through the new stack.
- [ ] A message from a phone-hidden user (BSUID only) is answered; no phone number is sent to `apps/auth` or `apps/api`, or stored by them.
- [ ] The same BSUID maps to the same user and thread across messages; a different BSUID is treated as a new user.
- [ ] `apps/api` authenticates WhatsApp requests solely via the JWT from `apps/auth`; no WhatsApp-specific login logic exists in `apps/api`.
- [ ] After more than 3 hours of silence, the next message starts a new thread and the previous thread and its messages are deleted; each user always has exactly one thread.
- [ ] Answers longer than 4000 characters are delivered as multiple messages in order, with WhatsApp-compatible formatting.
- [ ] Meta always receives a success response immediately for deliveries to our number, and Meta's signature is verified.
- [ ] Status updates, webhooks for other numbers and unsupported message types do not trigger a chat answer.
- [ ] With `WA_MAINTENANCE_MODE` on, users receive a maintenance notice and no chat answer, whatever `apps/api`'s `MAINTENANCE_MODE` is set to.
- [ ] In staging, messages starting with `!d ` are ignored; other messages are processed.
- [ ] No legacy users or threads are migrated.
- [ ] Unit and integration tests cover the above, using mock Meta and mock backend clients as in the legacy service.

## Constraints

Baked Decisions (from issue #321; fixed for this spec, not to be re-opened in the spec, plan or review):

- **Architecture (decision 1):** a separate WhatsApp service in the monorepo (for example `legacy/whatsapp`) that calls `apps/api` over HTTP. It starts as the existing Python service, imported as is as much as possible.
- **User identity (decision 2):** the WhatsApp service sends the user's BSUID (never the phone number) to a new `/whatsapp` endpoint in `apps/auth`, gets a JWT back, and calls `apps/api` with the message text and that JWT. `apps/api` identifies the user by the GUID in the JWT. This app stores neither the BSUID nor the phone number, only the GUID and the user's settings (in the existing `preferences` table). A new BSUID means a new user, with no identity continuity.
- **Answer format (decision 4):** use the existing streaming endpoints and aggregate their output into messages split for WhatsApp, as the legacy service does.
- **Incoming messages (decision 5):** always answer Meta "OK" immediately, with no queue or message log table.
- **Existing users (decision 6):** none are migrated, we start fresh.
- **Rate limiting (decision 7):** out of scope, no per-sender limiter in our code.
- **Deferred to later specs:** data retention for stale users (decision 3), translating the service to TypeScript, and dedicated non-streaming answer endpoints.

Self-made decisions (8 to 11, approved by the author, open to comments): global 3-hour conversation expiry; one thread per user, replaced on expiry; `!d ` prefix kept for staging; a WhatsApp maintenance flag, `WA_MAINTENANCE_MODE`, independent of `apps/api`'s.

Other constraints:

- Meta requires a quick response to webhooks; processing happens after the response.
- WhatsApp messages are limited to 4000 characters per message in the legacy design.
- The Python service uses `uv`, `ruff` and `pytest`; monorepo conventions apply to its placement and CI.
- Nothing is deleted for stale users in this spec (decision 3 deferred): a user who changes phone number leaves a stale identity in the auth layer.

## Assumptions

- `apps/auth` provides the `/whatsapp` endpoint and handles the fact that a WhatsApp user has no email (owned by Amr).
- Ansari uses a single Meta business portfolio and is not enrolled in parent BSUIDs, so the regular BSUID suffices (to be confirmed).
- The `/whatsapp` contract follows issue #329: `POST /api/whatsapp/session`, authenticated with `Authorization: Bearer <key>` where the key is an `apps/auth` API key (env name `AUTH_WHATSAPP_API_KEY`), request `{ "bsuid": "US.…" }`, response `{ "token": "<JWT>" }` in the format `apps/auth` already issues, errors as `{ message }` (400 malformed BSUID, 401 one identical body for every key failure, 500).
- The key is a revocable, permission-scoped client credential, not a shared secret: a leaked key can mint tokens only for WhatsApp users, within a per-key budget. Each WhatsApp user reuses one session, so this service caches the token per BSUID for a little under the token's 15-minute life. `apps/auth` applies per-key limits instead of per-IP ones.
- The `preferences` table (one row per setting keyed by GUID) is the home for user settings; today that is only preferred language, and expiry stays global.
- Meta's own throughput limits and webhook retry behaviour sufficiently bound traffic (see Baked Decision 7); this has not been load tested.
- Message-ID duplicates from Meta are rare enough to ignore (Baked Decision 5).

## Solution Approaches

The architecture, identity and answer-format questions are settled by the Baked Decisions. Remaining open space is how the imported service is introduced.

### Approach 1: Import the Python service as is, then adapt identity and thread lifecycle

Bring the legacy service into the monorepo with minimal change, replace its legacy user registration with the `apps/auth` token exchange, then add the thread lifecycle.
- Pros: matches the Baked Decisions; proven behaviour; smallest first step; keeps WhatsApp deploys separate.
- Cons: adds a Python app to a TypeScript monorepo until the later translation.
- Risk: low to moderate; the main dependency is the `/whatsapp` contract.

### Approach 2: Rewrite in TypeScript immediately

- Pros: consistent stack; reuse of `packages/`.
- Cons: contradicts the Baked Decisions (deferred); larger scope and regression risk.
- Risk: higher.

Recommended: Approach 1.

## Open Questions

**Critical**
- None. The `/whatsapp` contract in Assumptions is settled by issue #329.

**Important**
- Where do the WhatsApp service's secrets and per-environment Meta credentials live in the monorepo's deployment setup?
- How does `apps/api` expose thread deletion/replacement for the thread lifecycle (existing endpoints suffice, or a change is needed)?
- How are sources, links and tool activity from the streaming output rendered as plain text in WhatsApp messages (legacy behaviour assumed)?
- Should BSUID changes from Meta's system-message webhook be handled? Under Baked Decision 2 a changed BSUID is a new user, so this spec assumes no. A community comment on #321 (morningstar620) suggests otherwise.

**Nice-to-know**
- How many legacy users are phone-hidden, and how often do duplicate Meta deliveries occur in practice?
- Whether a dedicated staging Meta number can retire the `!d ` prefix.

## Test Scenarios

- Phone-visible user sends text: registered via token exchange, answered.
- Phone-hidden user sends text: answered; no phone number in any outgoing call or log.
- Two consecutive messages within 3 hours: same user, same thread, context retained.
- Message after 3 hours: old thread and messages deleted, new thread created.
- Same user with a new BSUID: treated as a new user.
- Long answer (above 4000 characters): split in order at sensible boundaries.
- Status webhook, webhook for another business number, and non-text message: handled without a chat answer (unsupported types get the unsupported notice).
- Invalid or missing Meta signature: rejected.
- Webhook verification handshake succeeds with the right token, fails otherwise.
- `WA_MAINTENANCE_MODE` on: maintenance notice, no chat processing, whatever `apps/api`'s `MAINTENANCE_MODE` is.
- Staging with `!d ` prefix: ignored; without: processed.
- `apps/auth` unavailable or returns an error: user receives a failure notice, error logged, Meta still answered "OK".
- `apps/api` error or timeout during streaming: user receives a failure notice, error logged.
- Message older than the configured age threshold: user is notified, not processed (legacy behaviour retained).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `/whatsapp` contract changes after implementation starts | Low | Medium | Isolate the token exchange behind one client |
| `apps/auth` cannot support users without email | Low | High | Confirm early with Amr |
| Stale identities accumulate (retention deferred) | High | Low | Tracked as a deferred decision |
| Always-"OK" hides failed or lost messages | Medium | Medium | Log failures with request correlation and Sentry; revisit if lost replies appear |
| Streaming aggregation stays fragile (formatting, length) | Medium | Medium | Keep legacy splitter and formatter with tests; dedicated endpoints deferred |
| A Python app in a TypeScript monorepo complicates CI and deploys | Medium | Low | Treat as interim until the TypeScript translation |
| Phone-number change creates a new user and loses context | Medium | Low | Accepted by Baked Decision 2 |

## References

- Issue iaser-ai/ansari#321 (design decisions and meeting outcome of 2026-10-24)
- Legacy: `ansari-project/ansari-whatsapp`, `ansari-project/ansari-backend`; interim fix ansari-whatsapp#8 / PR #9
- Meta: business-scoped user IDs, webhooks overview, throughput documentation
