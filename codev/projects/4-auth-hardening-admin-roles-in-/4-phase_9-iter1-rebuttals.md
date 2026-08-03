# Rebuttal - Phase 9 (smaller hardening), Implement iteration 1

**Verdicts:** Gemini APPROVE - Claude APPROVE - Codex REQUEST_CHANGES. Codex's point ACCEPTED.

## Codex - register failure logging can expose user data

`register/route.ts` logged the full DB error object. A PostgreSQL/Drizzle error can embed the
submitted email, query params, or the password hash (e.g. drizzle's "Failed query ... params:[...]"
or pg's "Key (email)=(...) already exists"), violating backend/CLAUDE.md's "No user content in logs".
ACCEPTED.

Fix: added `safeErrorMeta(error)` which logs ONLY the error type name and, for driver errors, the
SQLSTATE `code` - never the message, query text, or params. `console.error('Registration error:',
safeErrorMeta(error))`. The client already received a generic 'Registration failed' (iter-none change).

Test (`register-newsletter.test.ts`): the generic-error test now also asserts the console output
contains neither the raw driver text ('constraint') nor the submitted email - i.e. raw detail is
neither returned NOR logged.

## Result
Full suite **569 passed, 3 skipped**; typecheck clean; build green.
