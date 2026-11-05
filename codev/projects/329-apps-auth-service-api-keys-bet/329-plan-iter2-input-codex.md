## Findings

1. **Blocking — Probe failure gates occur too late.** Phase 1’s manual failure rule stops only before Phase 5 (plan lines 115, 406), but Phase 4 already depends on `createApiKey` and `updateApiKey`. Each probe needs an explicit fail-closed gate before its first consumer: key probes before Phase 4, JWT/field/lock probes before Phase 5, and logger/outage-mapping before Phase 6. The current wording could permit building Phase 4 after a contradicted key probe.

2. **Blocking — Success criteria do not have unique phase ownership.** There is no traceability matrix, and several criteria are duplicated while others lack a named test. Claim equality is tested in Phases 1 and 5; expired-ban behavior in Phases 5 and 6; raw-key hashing in Phases 1 and 4. Missing or incomplete named tests include:
   - list/rotate/revoke output fields required by spec line 239;
   - every script/subcommand’s database URL, confirmation, hostname, and key-id behavior (line 240);
   - zero database queries for missing/malformed bearers (line 258);
   - `UserGone` mapped through HTTP to 500 (line 260);
   - a pre-ban JWT subsequently failing `/api/account/me` (line 274);
   - exhaustive body sanity cases, rather than “body cases” (plan line 334);
   - captured Sentry events excluding the phone number (line 290);
   - alert one-event-per-window behavior (line 297).
   
   Add a criterion → owning phase → named test table, distinguishing early probes from the single acceptance-test owner.

3. **Blocking — Security requirements are weakened in several places.**
   - The boot test checks `{name, code}` only for `42P01`; the missing-constraint refusal also requires that log shape (spec line 234, plan lines 347–349).
   - The plan says exchange alerts carry “counts and windows only” (plan line 318), while the approved alert posture includes counts, windows, and hash prefixes (spec lines 295 and 325). Either preserve that posture or explicitly amend the spec.
   - The Sentry capture test omits phone-number exclusion (plan line 343 versus spec line 290).
   - The script test says only “the Sentry event,” rather than independently proving create, rotate, and revoke each emit exactly one event with all required fields (spec line 244).

4. **Blocking — The promised durable operator audit record is not guaranteed.** The plan lets an action succeed when `Sentry.flush` fails, leaving only terminal output (plan line 213). That contradicts the durable-event requirement at spec line 98. Define the intended durability contract: fail the write before execution, persist an outbox/audit row, or amend the approved requirement. Merely reporting failed delivery on stderr is not durable.

5. **Should-fix — Per-phase green status is underspecified.** Phase 1 names only the two auth package suites plus lint/typecheck, while root `turbo run test` appears only in Phase 7. “All suites pass” elsewhere is ambiguous. Since every phase is a commit, each should name the same root green command or a justified complete affected-package set. Phase 4’s instruction to run CLI subcommands manually against a “pglite-backed” database also needs a concrete runnable harness; the production CLI otherwise expects a PostgreSQL URL.

6. **Should-fix — The plan explicitly permits an existing-test edit forbidden by the spec.** Plan line 146 allows Better Auth log-output tests to be edited and merely listed in the commit message. Spec line 330 permits existing-test edits only for blocked-path, schema, and reserved-check enumerations. Remove that allowance or amend the specification.

7. **Should-fix — Wrong-content-type handling describes the wrong library mechanism.** I verified the installed `body-parser@2.3.0`: an unsupported media type is normally skipped by `express.json`, not raised as an `entity.parse.failed`/`entity.too.large` parser error. Validation can still produce the required 400, and the HTTP test should pin it, but the implementation must not depend on the route-local parser error handler seeing this case. This is the one place my review relies on library behavior neither document records as probed.

## Migration, deployment, and scope

The plan adequately covers `0001` numbering by main, generated-and-reviewed SQL, migration-before-code documentation, the duplicate pre-check, and the `ACCESS EXCLUSIVE` quiet-window warning. It does not introduce `db:push`.

No material scope creep was found. The daily alert and the additional real-Postgres session-insert check are reasonable hardening; `update-limits` is already required by the approved specification.

The highlighted requirements for the one 401 body, relation check with TTL, CORS-before-`corsFor`, pool-level per-user budget, claim equality, and lock/statement timeouts are otherwise retained.

**REQUEST CHANGES (probe gates; criterion ownership and missing tests; security assertions; durable Sentry record; per-phase green commands; existing-test contradiction)**