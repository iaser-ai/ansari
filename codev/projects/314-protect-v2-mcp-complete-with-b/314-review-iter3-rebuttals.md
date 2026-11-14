# Review (PR #372), iteration 3 (after the owner's Amendments 2 and 3): responses

## Codex (REQUEST_CHANGES)

1. **Pre-rename `wa_` keys would now be refused (401), though the runbook says they still verify.** Accepted and fixed.
   - Nobody can confirm that no live `wa_` key remains, so `wa_` joins the compatibility window instead of being refused.
   - `LEGACY_PREFIXES` in `service-users.ts` is `{ whatsapp: ['ansari_wa_', 'wa_'], 'ansari-mcp': ['ansari_mcp_'] }`, accepted only while `LEGACY_UNLABELLED_KEYS` holds.
   - New explicit test: a `wa_` key exchanges, written independently of the list (removing `wa_` from the list fails it). The MCP verify route refuses `wa_`.
   - Runbook: both the prefix-change paragraph and the "Rotate legacy keys" step name `wa_`.
2. **The branch is 9 commits behind `develop`.** Rebased onto `origin/develop` with no conflicts; develop's changes touch only `apps/mcp/test/*`. Build, typecheck, lint and the full suite pass after the rebase.

## Gemini (COMMENT: lane skipped)

The first run did not review: `agy` exited with code 3 (output kept as `314-review-iter3-gemini-skipped.txt`). It was re-run against the pushed branch; see `314-review-iter3-gemini.txt`.

## Also in this iteration (main, via the security architect)

`RAILWAY_ENVIRONMENT` is removed from `turbo.json` `globalEnv`, and the static-read comment now lists `ENVIRONMENT` in its place. Nothing reads `RAILWAY_ENVIRONMENT` any more.
