I verified the current auth sources/config; the iteration-2 spec itself is not present on disk, so I reviewed the supplied revision against them.

## A. Original blocking findings

1. **Eligibility check — CLOSED.** Eligibility is re-read under the user lock and covers sole WhatsApp account, reserved domain, `registered_via`, and non-admin role.
2. **Ban before lock — CLOSED.** The lock and re-read now precede the ban decision.
3. **Session/token/JWT mechanics — CLOSED at specification level, but unproven.** It names `internalAdapter.createSession`, keeps the session token internal, and uses server-only `signJWT`; transaction binding, token generation, claims, and exact expiry remain planned probes rather than proven behavior.
4. **Unapplied migration misclassified as 401 — CLOSED in intent.** The relation-level check and boot assertion address it, although their cache creates a new contract contradiction below.
5. **Missing service user looked revoked — CLOSED.** It is explicitly 500 plus an alert.
6. **“Start not stored” mechanism — CLOSED.** `startingCharactersConfig.shouldStore: false` is named and has a planned probe.
7. **False blocked-prefix claim — CLOSED.** The revision accurately distinguishes existing exact matching and adds a canonicalized API-key prefix rule.

## B. New gaps

### Blocking

- **Cached relation check contradicts the promised outage behavior.** A cached successful check permits an unknown key to receive 401 during the cache window after the database fails, which the residuals acknowledge, while success criteria require a stopped database to return “500, never 401.” Separately, missing authorization must be answered without touching the database, contradicting “before any 401” the relation is checked. Define precisely which refusals run the check, the TTL, and outage-test timing; remove the absolute “never 401” claim if the residual remains.

- **The per-user budget does not protect the shared key budget as claimed.** `verifyApiKey` consumes the key’s remaining/window budget before the body is parsed and the user budget is checked. A looping user can therefore continue receiving 429 while still exhausting the service key for everyone. The per-user budget limits successful exchanges, not key consumption; the risk statement and mitigation must be corrected or the ordering/design changed.

- **The `FOR UPDATE` resolution is still conditional on unprobed Better Auth behavior.** The current `routes/account.ts` only demonstrates obtaining the internal adapter; it does not demonstrate binding its writes to a Drizzle transaction. If session insertion uses another connection, it can wait forever on the parent-row lock while the locking request awaits that insertion. The real-Postgres probe is correct, but the specification needs a viable fallback that preserves serialization against bans, deletion, and concurrent account insertion—not merely “raise an alternative with the architect.”

- **The exact-expiry sequence is circular as written.** Session reuse is decided against the JWT’s exact `exp`, but signing occurs afterward. The spec must say whether it signs a candidate first, supplies an explicit expiry, or computes and then verifies the exact claim. This depends on currently unprobed `signJWT` behavior.

### Should-fix

- **Boot assertion scope and sequencing are underspecified.** Require the assertion to complete before `listen()`, with redacted failure handling. Checking only `auth.apikey` does not prove the accompanying `(provider_id, account_id)` constraint exists; either assert that constraint too or explicitly justify reliance on the migration’s single-transaction application.

- **New status details need tightening.** The 403 oracle is explicitly accepted and is coherent. For 429, specify that `X-Retry-After` is an integer number of seconds and how it is derived. This matters to the consumer contract.

- **500 for an ineligible mapped user is secure but operationally awkward.** It fails closed and makes corruption loud, but it classifies a permanent identity-state violation as a transient service failure, encouraging retries that consume key budget and repeat alerts. Either prescribe no automatic retry for this 500 class or choose a stable non-retry status without exposing further detail.

- **Alert identifier rules conflict.** Eligibility alerts are said to contain a user id, script events contain service/key identifiers and names, while the Alerts criteria say `alerts.ts` carries “counts only, no identifiers.” Split the policies by alert type and make the assertions consistent.

## C. Untestable or unreliable success criteria

- “Every canonicalized variant,” “any suffix,” “every Better Auth path,” and “any origin” quantify over infinite inputs. Define finite equivalence classes or property-test generators.
- “No response echoes any part of its input” is literally impossible/undefined; restrict it to complete sensitive values such as the bearer, BSUID, and request body.
- “No column contains any substring of length ≥4” is probabilistic because unrelated hashes, UUIDs, or metadata can coincidentally share four characters. Assert exact hashing, raw-key absence, and `start` being null instead.
- The stopped-database “500, never 401” criterion is incompatible with the accepted cache-window residual.
- A source-level assertion cannot prove runtime transaction/connection identity; only the real-Postgres probe can.
- “Several concurrent messages” needs a defined concurrency count, synchronization point, and expected responses.
- “Valid key with `auth.apikey` absent” must explicitly mean a formerly valid raw key after dropping the relation from an already-running service, because the boot assertion prevents starting in that state.

**REQUEST CHANGES (relation-check contract, per-user-budget claim, transactional session fallback, exact-expiry ordering).**