# spir-329 thread: service API keys + WhatsApp token exchange (issue #329)

## 2026-10-28: specify

- Read @better-auth/api-key 1.7.7 from the published tarball. Facts that differ from the issue/docs:
  owner column is `referenceId` (plus `configId`), not `userId`; `enableMetadata` defaults false;
  verify DELETES expired keys and exhausted no-refill keys; permission check precedes budget spend;
  plugin returns 429 for exhausted/rate-limited; verifyApiKey + deleteAllExpiredApiKeys are serverOnly.
- No existing operator script has a "refuse outside the auth image" guard; the spec raises its mechanism as an open question
  (a Dockerfile marker file is recommended, so no new env var is needed).
- apps/api resolveUser refuses only @system.ansari.chat, so the new no-login domain passes first use unchanged.
- Recommended approach: the exchange writes user+account in its own Drizzle tx, so the user.create.before hook refuses BOTH
  reserved domains unconditionally (stronger than the issue's "permit by context").
- PR #327 BSUIDs look like `US.13491208655302741918`; the pattern is proposed, to be agreed with the WhatsApp builder.

## 2026-10-28: spec iteration 1 (codex REQUEST_CHANGES; gemini skipped, agy not installed)

- Probed api-key 1.7.7 against pglite (throwaway test, reverted): remaining→0 WITHOUT refill DELETES the key on the next verify;
  WITH refill it is refused and kept, and the refill works (first one from a null lastRefillAt, and later cycles); rate-limited is kept; expired is deleted;
  a wrong permission spends no budget.
- verifyApiKey catches everything: a DB driver error comes back as INVALID_API_KEY (indistinguishable from an unknown key) and is logged raw
  through better-auth's logger. The spec adds a DB check before any 401 (outage → 500) and redacts better-auth's logger to {name, code}.
- Architect directions folded in: every valid:false → one 401; image guard dropped (scripts follow grant-admin's posture + print the DB host);
  schema mirrors the plugin model with generator column names.
- Codex points folded in: key referenceId bound to the WhatsApp service user (resolved by a `service` account row, never by email);
  one session per user under a per-user lock, near-expiry sessions replaced; wa-<random uuid>@domain address; 403 for banned.

## 2026-10-28: owner decision 1

- Domain: `@noreply.askansari.ai` (fixed reserved subdomain). Addresses use a kind prefix: `whatsapp-<user id>@…` (the user's own UUID, chosen by the exchange
  before insert, so the address is unique by construction) and `service-<service name>@…`. Considered and rejected: a hostname per user, and the bare @askansari.ai.

## 2026-10-28: spec iteration 2 (security architect's consolidated review: codex + claude, REQUEST_CHANGES)

- Folded in B1-B17. Notable: eligibility re-checked under the user-row lock (sole whatsapp row, noreply domain, registered_via, not admin → else 500 + alert);
  lock first, then ban/eligibility, session and signJWT in one transaction; relation-level pre-401 check + boot assertion; revoke = disable;
  no expiry on production keys; per-user budget (429) keyed by user id; blocked paths derived from apiKey().endpoints + prefix rule.
- Found while revising: FOR UPDATE on users conflicts with the KEY SHARE lock that the session insert's FK takes. If createSession ran on another connection,
  the request would block on its own lock. better-auth 1.7.7 has runWithTransaction/getCurrentAdapter; the plan must prove this on real Postgres.
- Corrected my own claim: LIKE 'whatsapp-%' cannot use the default-collation email btree; removed.
- signJWT is serverOnly, so /token's TOKEN_EXCHANGE_PER_SESSION is bypassed; the per-user budget replaces it.

## 2026-10-28: spec iteration 3 (owner D1-D4 + security review round 2)

- Owner: no BSUID regex (sanity bounds), BSUID raw, optional phone_number stored on auth.users (input:false, returned:false, never in /me),
  session row written directly under FOR NO KEY UPDATE. Decisions 3 and 4 are still open.
- Round 2 fixes: exchange mounted before corsFor; boot assertion only on definite 42P01/missing constraint (unreachable DB still starts);
  consumeWindow on the pool outside the tx (else refusals roll it back); explicit iat/exp to signJWT (signJWT omits iat otherwise);
  7 endpoints / 5 routed (serverOnly have no path); lock/statement timeouts; alerts counts-only, user id in log line.

## 2026-10-28: plan drafted

- Seven phases: (1) plugin, schema, migration 0001 and the blocked surface, plus probes (the plugin and its route block share one commit, so no commit exposes /api-key/*);
  (2) redacted logger as its own commit; (3) noreply domain; (4) operator scripts; (5) identity and session core in packages/auth;
  (6) route, boot assertion, alerts; (7) e2e, source scan, docs.
- Decision 3: formulas in P/D/U/N (legacy peak msg/min, daily msgs, DAU, instances), PROVISIONAL values, wide create-script bounds; the data was requested from the owner.
- No committed real-Postgres test infra exists (spec 300's Docker boot test was a manual run), so probe 4 and the outage run are manual against postgres:18, with output in the review.
- auth-journal-parity asserts a "single 0000" journal and schema tests assert six tables; both change in phase 1. AUTH_DEPLOYED_THROUGH stays main's.

## 2026-10-28: implement phase 1 (plugin, schema, 0001, blocked surface, probes)

- Main approved via security: migration tag 0001_api_key_phone (additive only); AUTH_DEPLOYED_THROUGH bumps to 0001 at the rebase, with a second
  auth-journal-applied line in RELEASE.md; merge precondition: owner applies 0001 to STAGING before merge, and to PRODUCTION before promote
  (duplicate check, apply, verify). Builders cannot afx send architect:main (router refuses); relay via security.
- Probe 4 on real Postgres 18.6: all 8 steps as planned, incl. the FOR UPDATE hazard reproduced (C'), and pool starvation: sign-after-commit 10/10 on a pool of 2,
  sign-inside hangs (no connect timeout) or fails loudly (timeout). Output is in codev/reviews/329-*.md.
- Probe 4a surprise (benign): sign-up with phone_number is REFUSED 400 FIELD_NOT_ALLOWED, not silently ignored; nothing stored.
- The probe script lives in packages/auth/scripts/probes (apps/auth has no direct pg/drizzle dep), a deviation from the plan path.
- The prefix rule was proven load-bearing by removing it (2 tests go red).

## 2026-10-28: phases 2 and 3

- Phase 2 (redacted logger) approved. The flaky secrets/copy hooks got their own 100 s deadline (measured: max 47 s, N=6; 30 s red 4/5 and 3/5, 100 s green 5/5).
  The shared machine (load 20-90 from other builders and simulators) makes the full root run red from timeouts in 5/6 runs across packages:
  evidence in the review for main's monorepo-wide follow-up. Per-package runs are the reliable signal here.
- Skipped porch's context-refresh task at the phase_3 boundary (a second porch next moved on).
- Phase 3: isReservedAddress covers @noreply.askansari.ai; isSystemAddress is untouched. The reset sender skips reserved addresses; grant-admin refuses noreply.
  The spec's "surrounding spaces → 409" doesn't match the guard order (validation first → 400 for all); the test asserts identical answers instead.

## 2026-10-28: phase 4 (service users and key scripts)

- packages/auth/src/service-users.ts (SERVICES, SECRET_SCANNING_PATTERNS, createServiceUser in one tx, findServiceUser none/one/many, listServiceKeys without the hash).
  limits.ts gains WHATSAPP_KEY_INITIAL (60/60 s, 3000/24 h) and WHATSAPP_KEY_BOUNDS, both in ms, as the plugin stores them.
- apps/auth/scripts/service-keys.ts: create-service | create-key | list | rotate | update-limits | revoke. grant-admin posture. Exit 2 = nothing written, 3 = written but the Sentry record was not sent (banner).
  create-service confirms with the service name, since there is no id yet.
- urlHost moved to apps/auth/scripts/url-host.ts (+ urlHostPort).
- Surprise: apps/api's source scan forbids literal DB URLs in apps/auth scripts. The demo harness now uses setAuthEnv's DATABASE_URL instead.
- Phase 4 review iter 1 (codex): the host line printed after the write (buffered output). Lines now stream, and the host line comes before connect().
- Phase 4 review iter 2 (codex): a REAL leak. Sentry's default Console integration turned the console.log'd raw key into a breadcrumb on the operator event.
  The test used defaultIntegrations:false and so hid it. Fix: the script's own Sentry options (no breadcrumbs) + stdout.write printing; test with production defaults.
  Gemini lane skipped both rounds (agy exit 3).

## 2026-10-28: gate before phase 5 (security architect's order)

- Rerun on real Postgres 18.6, outputs pasted verbatim in the review: probes 2, 4a and session token (new
  packages/auth/scripts/probes/library-probes.ts, 5/5) and probe 4 (8/8). All match the plan. Shared probe setup moved to probe-db.ts.
- For lessons-learned at the review phase (security architect): with Sentry's default integrations, anything printed through console
  becomes a breadcrumb and travels with the next event. A one-time secret print needs breadcrumbs off and direct stdout, and a log-capture
  test is not enough on its own: a production-shaped Sentry capture test is.

## 2026-10-28: phase 5 (WhatsApp identity and session core)

- packages/auth/src/whatsapp.ts: resolveOrCreateWhatsappUser + issueWhatsappToken (decideUnderLock in the tx, signJWT after commit), typed outcomes.
  Address eligibility is EXACT (whatsapp-<own id>@noreply…), stricter than the spec's "under the domain"; recorded in the review.
- Lifetimes moved to src/lifetimes.ts so createAuth and the exchange share them. 26 pglite tests, mutation-tested (7 mutants, all red).
- Surprise: a signJWT-inside-the-tx mutant HANGS pglite (single connection), the pool-starvation hazard in miniature. Caught by the source-level test.
- Probe 4 rerun on real Postgres with new F1-F4 steps through the real functions: 12/12. First run misread F3, because drizzle wraps driver errors
  (the SQLSTATE is on .cause). Phase 6's 500 mapping and logging must read the cause, as redactError does.

## 2026-10-28: phase 6 (exchange route, boot assertion, alerts)

- POST /api/whatsapp/session built, mounted ahead of corsFor and answering every request to its path itself. Boot assertion refuses only on 42P01 or a missing constraint.
- Production-shaped run on Postgres 18.6 (NODE_ENV=production, container stopped and started under the service): 13/13. 500 never 401 after the TTL, lock_timeout 500 at 2027 ms, /health recovers. Output in the review.
- FINDING (pre-existing, spec 300), sent to security: Sentry's default request-data integration attaches the request body and Authorization header
  to any event raised in a request, despite sendDefaultPii:false. The failed-sign-in alert event carried the sign-in email + password + bearer.
  Security owns the develop fix; this PR scrubs the exchange path only (with a negative control). Reproduction is in the review.
- apps/api full suite flaky at load ~65 (12 files hit 30 s timeouts); all pass in isolation.

## 2026-10-28: phase 7 (end-to-end, scan, docs)

- Exchange token passes apps/api requireUser end to end through the real threads route; app row registered_via='whatsapp'; no phone/BSUID in any app row.
- resolve-user pins the system-only first-use refusal (mutation proven). Scan 5: 0 hits in 65 files, planted file proven red.
- Runbook docs/cutover/service-keys-runbook.md + doc tests that read the code (patterns, alert kinds, subcommands, limits). Key log = a table in the runbook.
- Doc defect fixed everywhere: grant-admin refuses BOTH reserved domains (arch.md, RELEASE.md said system only).
- Contract summary for #327 sent to security for relay.

## Review phase (2026-10-28)
- Review doc rewritten into the template; probe outputs and phase notes kept as an appendix. One spec criterion open: staging smoke (#327's builder, pre-production gate).
- Lessons routed cold (new spec 329 section in lessons-learned.md); hot map entry for spec 300 extended to name spec 329 (count unchanged). arch-critical unchanged (at cap).
- Merge precondition unchanged: AUTH_DEPLOYED_THROUGH -> 0001 at the rebase after spec 300 cutover; 0001 applied to staging before merge.

## Merged develop (2026-10-30)
- Owner asked to merge develop into the branch: 98 commits incl. #327 (WhatsApp service), #323 (apps/mcp), #328. Merge commit 62dbe6f7.
- Conflicts: lessons-learned.md (kept both new sections: spec 321 and spec 329); pnpm-lock.yaml (took develop's, regenerated with `pnpm install --lockfile-only`; frozen install passes; apps/mcp importer kept).
- develop's auth journal still only has 0000, so no migration-number clash.
- Verified: typecheck + lint 13/13; @ansari/auth 252+1 skip, ansari-auth 467, ansari-api 1134+3 skip, frontend 774 each green alone. The full parallel root run hit pglite 30 s hook timeouts at load 52-74 (same signature as the recorded flaky class).

## Scope change: phone-number plugin and claim-by-phone (2026-10-30)
- Owner: "fold into the issue, database changes need to be sorted out now as we haven't run the migrations yet". Security gave the design (gate reopened).
- Spec amended: new §5 (schema in 0001 in place, plugin enabled and unblocked with a stub sender, verified by construction, claim by phone in the exchange, widened eligibility, link notice, residual). Open points §5.7 sent to security before planning.
- Owner withdrew amendment 1 (2026-10-30): "drop phone number entirely, whatsapp id is enough". Spec §5 is now "Owner amendment 2: no phone number" (phone_number accepted and ignored; no column; D3 reversed). Plan phase 8 = "Remove the phone number" (+ T12 staging check, 0001 regenerated as 0001_api_key, better-auth model test). Amendment-1 record (probe output, T1-T20, external reviews) kept in the review.
- Phase 8 (2026-10-30): phone removed (schema, config, exchange, route accepts and ignores), 0001 regenerated as 0001_api_key (diff = phone column only), better-auth model test, no-phone source check, accept-and-ignore + all-tables scan tests, probes rerun on PG18 (3/3, 12/12). Porch re-walked phases 1-7 by replaying recorded 2026-10-28 reviews (normal mode; parent/none modes dead-end).
