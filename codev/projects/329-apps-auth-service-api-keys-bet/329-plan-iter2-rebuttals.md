# Plan 329, security architect plan review (codex + claude on 124d115): response

All items accepted.

- P1: sign after commit, with the same exp; explicit pool max and connectionTimeoutMillis in createDb; a pool-starvation probe (max=2, 10 concurrent) that also reproduces the hang with signing inside.
- P2: the session token comes from `generateRandomString(32, 'a-z', 'A-Z', '0-9')` (the public `better-auth/crypto` export, same generator family as createSession's generateId); a probe compares it with a createSession token's shape; a test pins length and alphabet. No new dependency, no deep import.
- P3: fail-closed gates before each probe's first consumer (key probes → phase 4; JWT, field, token, lock and pool → phase 5; logger and outage mapping → phase 6).
- P4: AUTH_DEPLOYED_THROUGH bump to 0001 with main's agreement at the rebase, raised in the journal-numbering message; idx [0, 1] and table-list edits.
- P5: per-key minute and day alerts read the key row (requestCount; refillAmount − remaining since lastRefillAt), not auth.rate_limit (pruned hourly); short-window alerts are in-process; a clock-advance test.
- P6: criterion → owner → test table added, with the missing tests codex listed.
- P7: wording aligned (counts, windows and hash prefixes); the missing-constraint refusal logs {name, code}.
- P8: flush with a timeout; on failure, a banner + key log + non-zero exit, with the write kept; spec amended.
- P9: spec "Unchanged" criterion amended to name log-output tests.
- P10: the route checks Content-Type itself; tests for text/plain and a missing content type.
- P11: an apps/api resolve-user test pins the system-only refusal; recorded in arch.md.
- P12: one green command per phase (root turbo test, typecheck and lint, cold at least once); a runnable demo harness for the phase-4 CLI.
- Nits: session updatedAt named; ipAddress and userAgent written as ''; runbook avoids a bare apply line; users.ts header fix in phase 6; two better-call copies noted in the risks.

---

# Plan 329, iteration 2 (phase 8): response, 2026-10-30

Reviews on d3b92b00: codex REQUEST_CHANGES (5 points); gemini COMMENT (skipped, agy exit 3). In parallel: the security architect's own review and external round (T1-T20, `329-plan-iter2-input-security-T1-T20.md`).

**All five codex points are N/A: the plan they reviewed was withdrawn.** All five concerned owner amendment 1 (the phone-number plugin and claiming by number): Sentry injection for the stub sender, a claimable holder already linked, phone-number normalisation, race assertions, and wiring for the mailer and the phone alert. Before any of it was built, the owner replaced amendment 1 with amendment 2: "drop phone number entirely, whatsapp id is enough". Phase 8 is now "Remove the phone number" (spec §5). There is no plugin, no claim, no number to normalise and no notice. The points were accepted on their merits while amendment 1 stood, and drafted, but those drafts were discarded with it. The security architect's T12 carries into the new phase 8; T1-T11 and T13-T20 are moot. The record is in the review, under "Owner amendment 1: withdrawn".
