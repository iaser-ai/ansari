## 1. Delegation boundary

- **Blocking — Existing account rows can cross the boundary.** Looking up only `(provider_id='whatsapp', account_id=bsuid)` proves that the user has a WhatsApp account, not that they are exclusively a WhatsApp user. The schema permits the same user to also have `credential`, `service`, or another provider account, and permits their `users.role` to become `admin`. The exchange must atomically require `registered_via='whatsapp'`, the non-interactive domain, a non-admin role, and exactly one account row whose provider is `whatsapp`; otherwise refuse. This eligibility check must occur under the same user lock as session issuance. The current `grant-admin.ts` also refuses only the system domain, so it must refuse the new domain.

## 2. Oracles, enumeration, and timing

- **Should-fix — The route exposes BSUID state through timing and mutation.** A valid key gets substantially different work for an existing BSUID versus a missing one—lookup/reuse versus a transaction, inserts, conflict handling, and session creation. A key holder can therefore test whether a BSUID was previously registered, while guesses also create durable users. The intentional 403 separately reveals ban status. If this is accepted because the WhatsApp service is the delegation authority, state that threat assumption explicitly; otherwise add mitigation and monitoring.

- **Should-fix — Reserved-domain anti-enumeration relies on unprobed library behavior.** “Sign-in exactly as unknown” and reset responses being identical do not establish timing equivalence between an existing passwordless user and an unknown address. The specification records no Better Auth probe for these paths. Test latency/query behavior or explicitly accept that only response-shape equivalence is guaranteed.

## 3. Concurrency and consistency

- **Blocking — Ban and token issuance race.** The ban check precedes the user-row lock. `banUserByEmail` updates the user and deletes sessions transactionally, but an exchange can read “not banned,” let the ban delete sessions, then acquire the lock and create a fresh session for the now-banned user. Acquire the user lock first, re-read eligibility and ban state under it, and perform session deletion/creation in that same transaction.

- **Blocking — “Session outlives JWT” is not precisely guaranteed.** Testing whether a session expires more than 15 minutes from an earlier `now` can still yield a JWT whose actual `exp` is later than the session expiry. Session acceptance must compare against the exact issuance timestamp/expected JWT expiry, preferably with a safety margin, and the transaction must commit before the token is returned.

- **Should-fix — PGlite seams do not prove PostgreSQL locking.** They can prove conflict-recovery logic but not that `FOR UPDATE`, concurrent account insertion, role changes, and session replacement serialize as claimed. Add a real PostgreSQL concurrency test or narrow the success criterion to what PGlite actually proves.

## 4. Availability and failure modes

- **Blocking — The post-refusal health check cannot reliably distinguish outage from refusal.** The plugin discards the original driver error. A failed verification followed by a recovered health check becomes 401, while a genuine unknown key followed by a new outage becomes 500. The sustained-outage test misses both transitions. Preserving the verification operation’s database failure—or relaxing the claimed distinction—is required.

- **Blocking — Unknown-key traffic is unbudgeted database amplification.** Every well-shaped random key performs plugin database work and then another health query, with no applicable key budget and, correctly, no per-IP rule. This public route therefore offers an unauthenticated database DoS path. Add a non-IP global/circuit-breaker design, cache bounded health information, or otherwise avoid the second query without weakening outage semantics.

- **Should-fix — Budgets are per key, not per service.** Rotation doubles the service’s effective ceiling, and additional live keys multiply it further. Decide whether limits are intended per credential or per service and test the aggregate behavior. The actual production limits also need resolution before approval rather than remaining “about twice peak.”

- **Should-fix — Request parsing needs a size and ordering design.** Express JSON middleware normally parses before the handler if mounted conventionally, contradicting “key first,” and no body limit is specified. Define route-local authenticated parsing with a strict byte limit so invalid or oversized bodies cannot consume memory before authorization.

## 5. Success criteria

- **Blocking — Cleartext `start` storage contradicts the recorded probe.** The probe says the plugin stores the prefix plus three random characters, while the criteria require `start` not to be stored. The specification names no probed plugin option or implementation step that changes this default. Specify, probe, and test the exact configuration.

- **Blocking — JWT issuance from a hand-created session is unspecified and unprobed.** The specification does not identify a supported Better Auth API that accepts the created session and emits the normal JWT, including how the session token is generated and supplied. Tests can detect a mismatch, but the proposed implementation path is not established by the recorded probes.

- **Should-fix — The logging criterion is broader than its test.** Capturing `console.*` cannot prove that no Sentry event, platform access log, Better Auth logger sink, or other alert contains an Authorization header, BSUID, or driver object. Scope the assertion to controlled application sinks and separately configure/test Sentry request-header redaction. The custom Better Auth logger contract itself should also be probed.

- **Should-fix — Missing security scenarios.** Add tests for a WhatsApp account attached to an email, service, or admin user; promotion after initial creation; the ban/issuance race; transient database failure/recovery; invalid-key flooding; multiple-key aggregate budgets; and a database URL containing credentials to prove “print host” never prints userinfo.

## 6. Standing invariants

- **Blocking — Admin isolation is incomplete.** Admin truth remains correctly located in `users.role`, but that makes the missing role check especially consequential: a WhatsApp-linked user promoted through the existing operator script would receive an ordinary JWT and then be recognized as an admin by the established HTTP check. Refusing the new domain in `grant-admin.ts` and rechecking `users.role` during every exchange are required.

- **Should-fix — Secret-safe host output needs a precise definition.** “Print the database host” must mean parsed hostname and optional port only—not the raw URL, username, password, query string, or database URL parse error. Apart from this and the admin-boundary issue, the two-database, public-origin, system-domain, per-IP, and role-source invariants are preserved.

## 7. Scope

- **Blocking — Key delivery and storage are missing and contradict “no secret leaves its moment.”** The WhatsApp service must receive and persist the raw key, so it cannot exist only in the creating process’s output. Specify the secure operator-to-Railway handoff, consumer secret storage, rotation procedure, and observability redaction. Printing once is not itself a complete secret-lifecycle design.

- **Should-fix — Operational documentation is promised but not required.** `docs/self-hosting.md` and the runbook are mentioned, yet absent from the success criteria. Make key issuance, secure handoff, rotation overlap, revocation, expiry/pruning, budget sizing, and migration/deploy order required deliverables. The generic service-key primitive is otherwise justified; migrating the leaderboard remains correctly out of scope.

**VERDICT: REQUEST CHANGES (close account/role delegation, ban and expiry races, outage classification and invalid-key DoS, cleartext `start`, JWT issuance feasibility, aggregate budgets, and secret handoff/storage).**