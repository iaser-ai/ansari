# spir-16 thread — Refresh-token reuse: revoke-on-reuse policy + markTokenRotated result

## 2026-08-02 — Spawn + orientation (specify phase)

- Strict-mode SPIR builder for issue #16 (follow-up from PR #15 integration review).
- **Branch was stale**: `builder/spir-16` was cut before PR #15 (spec 4 auth hardening)
  merged, so `session_version`, `bumpSessionVersion`, `lookupRefreshToken` reuse
  detection — the primitives this issue builds on — were absent. Merged
  `origin/develop` (clean merge, commit 5ab8a9d) before drafting the spec.
- Read the post-merge auth surface: `refresh_token/route.ts` (atomic rotation tx),
  `lib/db/users.ts` (lookupRefreshToken / markTokenRotated / bumpSessionVersion),
  `lib/auth/middleware.ts` (validateRefreshToken reuse path), plus existing coverage
  in `session-version-reuse.test.ts` and `token-grace.test.ts`.
- No Baked Decisions section in issue #16. The issue itself delegates the policy
  decision ("decide revoke-on-reuse policy") to this spec; the spec-approval gate is
  where the human ratifies it.
- Key analysis for the spec:
  - Reuse detection fires at TWO sites: pre-validation (`validateRefreshToken`,
    logged) and the in-transaction recheck (currently silent generic 401).
  - `markTokenRotated` returning false conflates two very different cases: benign
    already-rotated-in-grace (concurrent refresh, issue #34) and row-vanished
    (concurrent revocation) — the latter is only safe because any revocation bumps
    `session_version`, making tokens minted off the stale read dead on arrival.
  - DoS tradeoff on revoke-on-reuse is bounded if the spent token is consumed on
    first reuse (replays then read `not_found` and cannot re-trigger revocation).

Next: draft spec → porch check → porch done → 3-way consultation.
