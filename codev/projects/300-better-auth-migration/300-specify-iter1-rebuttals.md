# Spec 300 — iteration 1 rebuttal

Changes are in `a910900` (with `60ca04d` for the security architect's first-round edits).

## Codex (REQUEST_CHANGES)

1. **I-2: the layer's limiter must be shared/database-backed.** Accepted. I-2 is now resolved in
   the spec: the layer's counters are database-backed and shared across instances, so an in-memory
   limiter is not allowed. A new success criterion and a test scenario (25) require two app
   instances on one database to share one budget. The plan chooses the mechanism (routing through
   Better Auth's in-process handler, or consuming `auth.rate_limit` directly).
2. **Existing admins outside `ADMIN_EMAILS`.** Accepted. A new criterion requires:
   - an `is_admin = true` inventory, compared with `ADMIN_EMAILS` before the window
   - an owner-approved post-cutover admin list
   - the role script assigning exactly that list
   - an audit that the `role = 'admin'` set equals the list

   `is_admin` is still not carried as a column, as decided. Test scenario 23 and a risk row cover
   this.
3. **Safe drop of the #59 scaffold tables.** Accepted. The main architect's condition 6 asked for
   the same thing. The additive migration drops them only behind an in-migration guard that aborts
   if any table holds a row, and test scenario 22 proves the abort. Whether the tables exist at all
   is now a `psql \dt` question for the owner.
4. **"Byte-compatible" is wrong for dynamic values.** Accepted. The wording is now
   "wire-contract-compatible": same status codes, field names, presence and types, while tokens and
   timestamps differ.

## Gemini (APPROVE): recommendations also taken

- The layer's rate limit should be shared across replicas. This is the same as Codex point 1.
- Session sliding on `refresh_token`. A new criterion and test scenario 26 require bearer
  resolution to slide expiry after `updateAge`, so regularly refreshing mobile clients are never
  logged out at 30 days.
- The lockfile is touched by adding `@ansari/auth` to `apps/api`. This is now stated under
  Reviewers (main architect, PR A).

## Other changes this iteration (architect direction, not reviewer feedback)

- **The main architect's seven single-journal conditions are folded in.** The numbering rule
  follows from the generate dry run.
- **The security architect's IP fallback.** Only failed attempts count per email, the 60-second
  lockout is an accepted and bounded risk, and a list-walk alert is added.
