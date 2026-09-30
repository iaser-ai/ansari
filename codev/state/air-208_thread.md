# air-208 thread

- Implement: `loadSession()` now infers `isGuest` from the guest registration name
  (`Welcome`/`Guest`) when a stored blob has no `isGuest` key. An explicit key still wins.
  The name moved into exported `GUEST_FIRST_NAME`/`GUEST_LAST_NAME` in `lib/auth/guest.ts`,
  so registration and the migration check share one source.
- Tests: 4 new `loadSession` cases. The guest-name case was negative-tested: it fails when
  the fallback is reverted to `?? false`. Full suite 387/387 before the new cases were added (now 391), tsc clean.
