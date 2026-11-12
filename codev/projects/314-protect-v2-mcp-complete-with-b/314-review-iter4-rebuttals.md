# Review (PR #372), iteration 4: responses

## Codex (REQUEST_CHANGES)

1. **`SECRET_SCANNING_PATTERNS.whatsapp` ignores `LEGACY_PREFIXES`, so an accepted `wa_` key goes undetected.** Accepted.
   - `LEGACY_SCANNING_PATTERNS` is derived from `LEGACY_PREFIXES`, minus the prefixes the main pattern already covers. Today that is `{ whatsapp: [/wa_[A-Za-z]{64}/], 'ansari-mcp': [] }`, and it is empty once the window closes.
   - New tests: every prefix any route accepts, in any environment, is caught by the main pattern or a legacy one; and the runbook names each legacy pattern by its exact source. Emptying the WhatsApp list fails the first.
   - The main patterns are unchanged, because their sources are what the owner registers in the runbook's table.
2. **`develop` advanced again (PR #376).** Rebased again.
3. **The review document lacked iteration 3, and its artifacts were uncommitted.** Committed with this iteration: the iteration 3 and 4 outputs and rebuttals, and the review's consultation section.
4. **`service-keys.ts` initialised Sentry with `NODE_ENV`.** Fixed. `scriptSentryInit(dsn, environment)` uses `ENVIRONMENT`, and `main` passes `process.env.ENVIRONMENT`. A test pins it under `NODE_ENV=production`.

## Gemini

Skipped twice: `agy` exits with code 3 (not installed or not signed in on this machine). No Gemini verdict exists for iterations 3 and 4.
