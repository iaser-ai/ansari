# PIR #124 — Review iteration 1: responses to consultation feedback

Verdicts: **gemini** COMMENT (lane skipped), **codex** REQUEST_CHANGES (HIGH),
**claude** REQUEST_CHANGES (HIGH).

Fixes pushed in commit **`cf47a79`**. One finding — signed-out usability — is a
product decision that has been **escalated to the architect + Omar**; it is not
resolved in this iteration and PIR's single pass will not re-review it, so it is
flagged for the human at the `pr` gate.

---

## gemini — COMMENT (lane skipped)

`agy` CLI not installed in this environment; the Gemini lane skipped
non-blockingly. Nothing to address.

---

## codex — REQUEST_CHANGES

### C1. "Signed-out usage is broken" — ESCALATED, awaiting product decision

**The finding is correct.** I verified it against `apps/api`:

- Every `/api/v2/threads*` route calls `authenticateRequest(request)`
  unconditionally at the top (`route.ts` for `threads`, `threads/[id]`,
  `threads/[id]/chat`, `.../name`, `.../share`).
- `apps/api/lib/auth/middleware.ts:22-28` returns `401 { detail: 'Not
  authenticated' }` when no bearer token is present. There is **no anonymous
  path**.
- Only `users/{login,register,refresh_token}`, `request_password_reset`,
  `reset_password`, `app-check`, `mcp-complete` are auth-free.
- `loginAsGuest()` (which registers a **real, persistent** throwaway staging
  account via the auth-free `register` endpoint) is wired only to the auth
  form's "Continue as guest" button.

So a `signedOut` user who never opens `/login` has no token, and the sidebar
list, ask-a-question, thread load, and send all 401.

**Why this happened:** the approved product call ("accountless-optional… the app
works signed-out; `apps/api` serves anon/guest threads") was premised on
`apps/api` serving anonymous threads. It does not. The premise was wrong, not
the implementation of it — `AuthGate` was built exactly as specified.

**Disposition:** this is a decision, not a bug fix. I have escalated to the
architect with three options:

- **(A) Auto-guest bootstrap** in `AuthProvider` — on `signedOut` with no stored
  session, silently `loginAsGuest()`. Faithful to "works signed-out / no forced
  redirect / auth optional"; "Log in" becomes "switch to a named account". ~15
  lines + a test. Operational cost: one persistent staging account minted per
  fresh browser (credentials cached on-device and reused). *Recommended.*
- **(B) Account-first** — `AuthGate` force-redirects `signedOut → /login`.
  Contradicts the product call.
- **(C)** something else Omar wants.

Also open under (A): what "Log out" does — land as a fresh guest, or truly
signed out until the next bootstrap.

The README's "serves guest and anonymous threads" line and the corrected
privacy copy will be reconciled with whichever option is chosen.

### C2. Composer violates the plan's loaded-thread guard, can lose input — FIXED (`cf47a79`)

Correct, and it was in my own plan ("Composer stays disabled until
`conversationQuery.data`"). `send()` bails on `!conversationQuery.data`, and
`ChatInput` clears its field on send (`ChatInput.tsx:340-343`, gated by
`canSend`), so a follow-up typed while an existing thread loads on a slow
connection was lost silently.

Fix: `app/chat/[id].tsx` composer is now
`disabled={conversationQuery.isError || !conversationQuery.data}`. `ChatInput`
already treats `disabled` as both non-editable (`editable={!disabled}`) and
non-sending (`canSend` includes `!disabled`), so the field can no longer be
typed into or submitted before data resolves.

---

## claude — REQUEST_CHANGES

### CL1. Composer isn't gated on loaded data — FIXED (`cf47a79`)

Same as **C2**. Fixed.

### CL2. `.env.local.example` is now actively wrong — FIXED (`cf47a79`)

Correct — the exact partial-docs-fix failure mode `lessons-critical` names. The
file still said `EXPO_PUBLIC_API_URL` "is NOT read by anything the UI actually
calls" and that `_layout.tsx` uses `EXPO_PUBLIC_DOMAIN` (the last stale
reference to that variable in the tree). Rewritten to describe the real
behaviour: `resolveBaseUrl()` reads `EXPO_PUBLIC_API_URL`, defaulting to
staging.

### CL3. Follow-up question not rendered until the post-`done` refetch — NOT FIXED (pre-existing, out of scope)

Correct that it is conspicuous now: a follow-up typed in the thread isn't shown
until the refetch lands, so the streamed answer appears with no question above
it. This is pre-existing behaviour from #121 — the reconciler only synthesises
the carried-in `q` echo, not thread-typed follow-ups — and fixing it means
extending `reconcileThread` to echo the just-sent message by identity (the same
trick as `ECHO_ID`, generalised). That is a behaviour change to a module #124's
scope explicitly excludes ("wiring, not behavior change to those modules").

**Disposition:** flagged in the review file's "Things to Look At", and a
follow-up issue candidate. Recommend filing alongside the web-fonts fast-follow.

### CL4. `logout()` doesn't navigate — FIXED (`cf47a79`)

Correct. Signing out inside an account-owned thread left the detail query to
refetch under the new principal and drop to the "This conversation didn't load"
screen. `Sidebar.signOut` and `AccountChrome`'s logout now `router.replace('/')`
before `logout()` (which clears the query cache), so nothing stale survives the
principal change.

### CL5. ListFooterComponent comment inaccuracy — FIXED (`cf47a79`)

Correct. The comment claimed the synthetic bubble "carries" the trace once text
streams; it doesn't — the trace is simply done its job. Comment reworded.

---

## Summary of changes in `cf47a79`

| File | Change |
|---|---|
| `app/chat/[id].tsx` | composer `disabled` gains `!conversationQuery.data`; ListFooterComponent comment corrected |
| `.env.local.example` | rewritten to match reality |
| `components/Sidebar.tsx` | `signOut` navigates home before `logout()` |
| `components/AccountChrome.tsx` | logout navigates home before `logout()` |

`pnpm typecheck` clean; `pnpm test` 218/218.

**Not resolved this iteration:** C1 (signed-out usability) — product decision,
escalated, flagged for the `pr` gate. CL3 (follow-up echo) — pre-existing, out
of scope, follow-up issue.
