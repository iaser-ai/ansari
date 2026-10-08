# air-253 thread

- 2026-10-08: #253 fix. `loadSession()` now treats the guest registration name as authoritative (`parsed.isGuest === true || nameMatch`) so a stale literal `isGuest: false` blob is rescued. Updated the old test that asserted explicit `false` beat the guest name (that was the bug); added a regression test, confirmed it fails on the pre-fix code. Accepted edge case: a real account named exactly "Welcome Guest" reads as a guest (documented inline). Full suite 594/594, tsc clean.
