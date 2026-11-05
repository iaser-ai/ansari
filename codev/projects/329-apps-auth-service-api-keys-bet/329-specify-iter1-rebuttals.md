# Spec 329, iteration 1: rebuttal

Reviews: codex REQUEST_CHANGES; gemini COMMENT (lane skipped: the `agy` CLI is not installed; no content to address).
Revision: commit c62d7b6.

## Codex key issues

1. **Resolve open questions that alter requirements.** Partly accepted.
   - Resolved in the spec, now under "Resolved in this revision": throttle statuses (every key refusal is the one 401, per the security architect); banned user (403 `Forbidden`); check order (key, then body); image guard (dropped, per the security architect; the scripts follow `grant-admin.ts`'s posture plus a printed database host); BSUID pattern (fixed as `^[A-Z]{2}\.[0-9]{10,32}$`, with the WhatsApp builder asked to confirm it against real webhooks); `start` not stored.
   - Not resolved, deliberately: the domain name, raw vs HMAC BSUID storage, the key's limits and leaderboard timing. These are the owner's decisions by the architect's instruction, answered at the spec-approval gate. Each has a recommendation, and the requirements are written against the recommended default (working domain name, raw storage), so planning is not blocked. Decision 3 was reshaped by a pglite probe: a refilled budget is safe (refused and kept), while a budget without refill deletes the key, so the script refuses that configuration.

2. **Bind `referenceId` to the WhatsApp service user.** Accepted. Service users are resolved by a `service` account row (never by email). Permissions are fixed per service in code (the script takes no free-form permissions). The exchange checks the verified key's `referenceId` against the WhatsApp service user, so a mis-owned key is refused with 401. A negative test seeds a `whatsapp: mint` key under another service user.

3. **"One session per WhatsApp user" not guaranteed.** Accepted. Session work for one user is serialized under a lock on the user's row. A near-expiry session is deleted when it is replaced, and the session carries no IP or user agent. The tests drive concurrent session steps through a seam, since pglite serializes connections.

4. **Privacy-safe email/name derivation and collisions.** Accepted. Address `wa-<server-generated random UUID>@<domain>` (independent of the BSUID); name `WhatsApp user`. An address collision is a 500, never a retry onto another user.

5. **Plugin error classification and logger redaction.** Accepted, and confirmed in the plugin source: `verifyApiKey` returns a driver error as `INVALID_API_KEY`, the same code as an unknown key, after logging the raw error object. The route checks that the database answers before returning 401 (outage → 500). Better Auth's logger is configured to reduce error arguments to `{name, code}`. Tests: a production-shaped outage (500 for valid and unknown keys) and log capture through the outage.

## Working-tree warning in the codex output

The three changed paths (`packages/auth/package.json`, `pnpm-lock.yaml`, `packages/auth/tests/probe-apikey.test.ts`) were my own throwaway pglite probe of the plugin, run during the review. It was reverted afterwards; the branch carries none of it.
