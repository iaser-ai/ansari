# Specification: Translate the WhatsApp service to TypeScript

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

The WhatsApp service currently lives in `legacy/whatsapp` as a Python/FastAPI application. The monorepo's application stack is TypeScript, so maintaining the WhatsApp service separately increases operational, deployment, and testing complexity.

Issue #358 translates the service to TypeScript while preserving the behavior established by spec 321, PR #327, and follow-up PR #339. The existing Python implementation and its 197 passing tests are the behavioral reference during the migration.

## Current State

The Python service:

- Receives Meta webhooks at `POST /whatsapp/v2`.
- Verifies Meta signatures and answers Meta with HTTP 200 immediately.
- Identifies users by BSUID and exchanges it for a JWT through `POST /api/whatsapp/session` in `apps/auth`.
- Calls `apps/api` using the JWT and streaming endpoints.
- Aggregates streaming responses into complete WhatsApp messages.
- Converts Markdown to WhatsApp-compatible text.
- Splits messages at 4000 characters.
- Supports `WA_MAINTENANCE_MODE`.
- Supports `META_REPLY_BY_PHONE`, disabled by default and refused in production.
- Provides masked, environment-specific logging.
- Runs as the Railway `whatsapp` service.

The monorepo uses TypeScript applications, `pnpm`, and Turbo. The exact TypeScript HTTP framework and runtime should follow the repository's existing conventions and will be selected in the plan after inspection.

## Desired State

A TypeScript WhatsApp service replaces the Python implementation while preserving its externally observable behavior and service contracts.

The service must:

- Receive and verify Meta webhooks at `POST /whatsapp/v3` (owner decision, 2026-11-10: the TypeScript service upgrades the route from `/whatsapp/v2`; the webhook callback URL must then be changed in each Meta app's webhook settings when that environment is switched over). `GET /whatsapp/v3` answers the verification handshake. The Python service keeps `/whatsapp/v2`.
- Return success to Meta immediately after validating the webhook request.
- Process supported messages asynchronously after acknowledgment.
- Exchange BSUID identity for a JWT through `apps/auth`.
- Call `apps/api` using the JWT and existing streaming endpoints.
- Preserve authentication, thread, maintenance, error, retry, and message-age behavior.
- Convert Markdown and split responses exactly as required for WhatsApp.
- Preserve masked, per-environment logging and request correlation.
- Integrate with the monorepo's `pnpm` and Turbo workflows.
- Include a TypeScript port of the operator script `legacy/whatsapp/scripts/check_meta_subscriptions.py` (owner decision, 2026-11-10), which lists and changes the Meta apps subscribed to the Messaging account.
- Redeploy the existing Railway staging `whatsapp` service with the TypeScript implementation. No production migration is part of this issue.

The Python service remains available as a behavioral reference until the TypeScript service has passed staging verification. A brief rollback note will be added to the legacy Python WhatsApp folder when the migration reaches deployment readiness.

## TypeScript Learning Notes

The implementation process should explain these concepts when they become relevant:

- **TypeScript:** JavaScript with a static type system. Types help catch invalid values before runtime, but they are removed when the code is compiled and do not validate incoming webhook JSON by themselves.
- **Runtime:** The program that executes the compiled or directly interpreted TypeScript. The plan must identify whether this service uses Node.js or another repository-supported runtime.
- **Framework:** The HTTP library that handles routes, request bodies, responses, middleware, and server startup. It is the TypeScript counterpart to FastAPI's application and route layer.
- **Types versus schemas:** Type annotations describe what code expects at compile time. Runtime schemas validate untrusted Meta and service responses while the program is running; webhook and API boundaries need runtime validation.
- **Promises and async/await:** TypeScript uses JavaScript Promises for asynchronous work. `async`/`await` is conceptually close to Python's `async`/`await`, but errors and response-body handling follow JavaScript Promise conventions.
- **Streams:** A streaming HTTP response arrives in chunks. The TypeScript client must consume all chunks, detect API-level errors reported after HTTP 200, and then apply the same aggregation and formatting rules as Python.
- **Modules and packages:** TypeScript source is organized into modules, and `package.json` declares dependencies and scripts. The migration should use existing monorepo package conventions rather than introducing a separate package-management style.
- **Middleware and dependency injection:** Framework middleware is commonly used for cross-cutting behavior such as signature verification, request IDs, logging, and error handling. The implementation should preserve ownership boundaries without copying FastAPI-specific patterns mechanically.

Each design choice in the plan and implementation should state the relevant Python behavior, the TypeScript equivalent, and any meaningful semantic difference.

## Compatibility Requirements

The TypeScript implementation must preserve:

- Meta webhook signature verification and webhook verification handshake.
- Immediate HTTP 200 acknowledgment for valid deliveries.
- BSUID-only identity handling; phone numbers must not be sent to `apps/auth` or `apps/api`.
- JWT caching, re-exchange after an `apps/api` 401, and one retry behavior.
- Conversation expiry and thread lifecycle.
- Unsupported-message, stale-message, banned-user, maintenance, and failure notices.
- 4000-character splitting and Markdown conversion.
- `META_REPLY_BY_PHONE` semantics, including refusal in production, while the setting remains needed.
- Structured masked logging by environment.
- Ignoring Meta status webhooks.
- Staging `!d ` filtering, if still required by the current Python behavior.

## Open Decisions

1. **Service location:** Create a new application under `apps/`, likely `apps/whatsapp`, while retaining `legacy/whatsapp` as the reference during migration. The plan should confirm the final directory and package naming against existing monorepo conventions.
2. **Runtime and HTTP framework:** Select the repository-consistent TypeScript runtime and HTTP framework. The plan must explain the Python/FastAPI comparison and why the selected tools fit this service.
3. **Phone-number reply behavior:** Retain `META_REPLY_BY_PHONE` during the migration for local/staging compatibility. Remove it only in a later change after issue #362 confirms that it is no longer needed.
4. **Railway deployment:** Redeploy the existing staging `whatsapp` service in place. Production deployment is out of scope.
5. **Deferred work:** Issues #359, #360, and #361 remain separate and must not be exposed as dependencies of this migration.

## Success Criteria

- [ ] A TypeScript WhatsApp application exists in the agreed monorepo location and runs with the repository's standard package and task tooling.
- [ ] The Python behavior tests are mapped to focused TypeScript tests covering webhook handling, signatures, authentication, streaming, formatting, splitting, maintenance, and failures.
- [ ] Phone-hidden BSUID users receive replies without phone numbers being sent to `apps/auth` or `apps/api`.
- [ ] Meta receives an immediate successful response for valid deliveries.
- [ ] Duplicate and status webhook behavior remains unchanged.
- [ ] Logging does not expose BSUIDs, phone numbers, tokens, or message content beyond the existing environment policy.
- [ ] `META_REPLY_BY_PHONE` remains disabled by default and refused in production.
- [ ] The Meta subscription script runs from `apps/whatsapp` with the same menu, explanations and confirmations as the Python script, and its read-only options work against staging.
- [ ] True/False settings accept the same spellings as apps/api (`true`, `false`, `True`, `False`, `1`, `0`) and refuse anything else; the Railway staging values are checked against that before the redeploy.
- [ ] Railway staging redeploys the existing `whatsapp` service with the TypeScript implementation.
- [ ] Staging smoke tests pass for visible-phone and hidden-phone users, including long responses and error paths.
- [ ] A brief rollback note is added to the legacy Python WhatsApp folder before staging migration is considered complete.
- [ ] The implementation documentation explains relevant TypeScript concepts and meaningful differences from the Python service.
- [ ] Code comments, doc comments (TSDoc) and configuration documentation are carried over from the Python service and kept as detailed: functions that deal with Meta logic keep their reference URLs to Meta's documentation and explain the why; `.env.example` and the TypeScript config module (the counterpart of `config.py`) document every setting, its allowed values, its default and which environments use it.

## Test Scenarios

- Phone-visible user sends text and receives an answer.
- Phone-hidden user sends text and receives an answer without phone-number propagation.
- Two messages within the conversation window retain the same user and thread.
- A message after the expiry window starts the expected new thread behavior.
- A long answer is split in order at WhatsApp-compatible boundaries.
- Status, wrong-number, stale, unsupported, and malformed webhooks follow existing behavior.
- Invalid or missing Meta signatures are rejected.
- Webhook verification succeeds and fails appropriately.
- Maintenance mode sends the maintenance notice without chat processing.
- Staging `!d ` filtering remains unchanged if retained.
- `apps/auth` and `apps/api` failures produce the existing user notices while Meta still receives the immediate acknowledgment.

## Risks and Mitigation

| Risk | Mitigation |
|------|------------|
| Webhook acknowledgment is delayed by asynchronous work | Test acknowledgment timing independently from background processing. |
| TypeScript types create false confidence for untrusted JSON | Validate webhook and service-boundary data at runtime. |
| Streaming aggregation differs from Python | Reuse behavior cases and test chunk boundaries, trailing errors, and completion. |
| Markdown or splitting behavior regresses | Port the existing tests before changing implementation details. |
| Railway environment configuration differs | Compare staging variables and perform a staging smoke test before considering the migration complete. |
| The team loses the proven Python reference too early | Keep `legacy/whatsapp` intact until staging verification and add the brief rollback note there. |

## References

- Issue iaser-ai/ansari#358
- Spec 321: `codev/specs/321-rfc-whatsapp-support-in-the-mo.md`
- Follow-up issues #359, #360, and #361
- Issue #362 regarding real phone-number requirements
- Python reference implementation: `legacy/whatsapp`
