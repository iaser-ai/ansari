# air-19 thread — Extend safeErrorMeta sanitized logging (issue #19)

## Implement

- Branch base (`bf164ae`) predated PR #15's merge, so `safeErrorMeta` didn't exist
  here yet. Merged `origin/develop` (1915e60, includes PR #15) to build on it.
- Extracted `safeErrorMeta` from `register/route.ts` into a shared module
  `backend/lib/log.ts` — exactly what PR #15's own review recommended instead of
  duplicating it per route.
- Applied it to the final catch-block logging in five routes: `users/login`,
  `reset_password`, `request_password_reset`, `users/refresh_token`, `feedback`.
  Register now imports the shared copy.
- Left the fire-and-forget email/newsletter logs alone — they already log only
  strings (`result.error` is typed `string` in `lib/email.ts`), not raw driver
  objects, and the issue scopes to raw `console.error(error)` sites.
- Tests: new `tests/safe-error-meta.test.ts` unit suite (name/code extraction,
  non-string code, non-Error throwables, no-leak property) plus a per-route
  leak-regression test in each existing route suite, following the register
  pattern from PR #15 (spy console.error, throw a driver-like error carrying
  user content, assert the content reaches neither the response nor the logs,
  and that the SQLSTATE code does).
- Verified: typecheck clean, full suite 595 passed / 3 pre-existing skips,
  `next build` green with the CI dummy env (`.env.ci`).

## PR

- Opened PR #29 against `develop` with the AIR review embedded in the body
  (summary, key decisions, test plan). Porch checks (pr_exists, e2e_tests)
  passed; PR gate requested. Waiting for human approval.

## Review iteration 1 (architect REQUEST_CHANGES)

- Defect confirmed: drizzle wraps pg errors in `DrizzleQueryError` (name
  `'Error'`, no top-level `code`, SQLSTATE at `.cause.code`), so the original
  `safeErrorMeta` returned a useless `{name:'Error'}` on real DB failures.
- Fix: `.cause`-chain walk (same traversal as `isUniqueViolation`,
  lib/db/users.ts) + `constructor.name` so the wrapper logs as
  `DrizzleQueryError` instead of `Error`.
- Tests: unit fixture built from the REAL `DrizzleQueryError` (imported from
  `drizzle-orm/errors`, query text + params as leak canaries) and the login
  route leak test upgraded to the wrapped shape. 596 passed / 3 skipped.
- Non-blocking review items intentionally NOT picked up (architect filing
  follow-up issues; no scope expansion).
