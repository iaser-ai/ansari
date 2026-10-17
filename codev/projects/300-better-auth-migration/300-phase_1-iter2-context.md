### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Strong contract coverage, but rejected-token error details are not frozen exactly as required.
- gemini: APPROVE — Phase 1 legacy contract test suite, PGlite harness, frozen fixtures, mutation verification, and client source audit are complete and well-executed.

### Builder Response to Iteration 1
# Phase 1 — iteration 1 rebuttal

Reviews: Codex REQUEST_CHANGES, Gemini APPROVE. (The "working tree changed" notice on both lanes
named `.consult-codex.log` and `.consult-gemini.log`, the builder's own consult logs. They are
deleted, and no tracked file changed.)

## Codex: `detailOneOf` lets phase 8 return a different legacy detail

**Partly accepted; changed.** Every rejection whose cause the post-migration backend can still
distinguish now has its own exact fixture:

| Scenario | Fixture | Exact detail |
|---|---|---|
| garbage bearer on `logout`, `me` GET, `me` DELETE | `bearer.invalid_or_expired` | `Invalid or expired token` |
| expired access token (`me` GET; the mobile cycle's 401) | `bearer.invalid_or_expired` | `Invalid or expired token` |
| bearer of a deleted account | `bearer.token_not_found` | `Token not found or expired` |
| garbage refresh token | `refresh_token.invalid` | `Invalid or expired refresh token` |

**Kept as `detailOneOf`, with reasons**, in two fixtures only:

- `refresh_token.rejected`: an access token presented as a refresh token, a session revoked by
  logout, a password reset, and a deleted account. Today these give three different strings
  (`Invalid token type`, and `Refresh token not found or expired` for the rest). In phase 8 the
  layer's only signal is a 401 from `apps/auth`'s `GET /api/auth/token`. The plan's phase 8 table
  says "401 → 401", and the layer has no auth-database access (spec). Exact per-cause pins would
  force phase 8 to edit assertions, which the plan forbids, or to give the layer access to the
  auth database, which the spec forbids.
- `bearer.rejected`: one scenario, a refresh token presented as the bearer (today
  `Invalid token type`). In phase 8 the refresh token is an opaque session token, which the JWT
  verifier cannot tell apart from garbage, which is pinned exactly above.

No client parses these details. `legacy/frontend-app` branches on `response.ok` / status 401 only
(`ApiService.ts:81-86`, `:107-109`), and the thread records that source read. The status code,
the exact key set `{detail}`, and the closed set of strings are still frozen. The fixture comment
now says `detailOneOf` is used only where the cause cannot be recovered.

Mutation check after the change: the suite still passes against today's code (58/58). Run 2 of
the mutation script caught `Invalid or expired token` and `Token not found or expired`. That
script did not mutate `validateRefreshToken`'s `return { error }` strings, so those two were
mutated separately afterwards: `Invalid or expired refresh token` CAUGHT, and
`Refresh token not found or expired` CAUGHT.

## Gemini (APPROVE): note for phases 7–8

Agreed. Recorded in the thread for phase 8: the tombstone path must return
`Token not found or expired` (now an exact pin), not just one of a set.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
