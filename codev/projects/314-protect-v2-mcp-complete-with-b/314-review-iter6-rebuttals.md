# Review (PR #372), iteration 6 (second external review's fixes): responses

## Codex (REQUEST_CHANGES)

1. **Scan 6 omitted `apps/api/scripts/**`.** Accepted. It is now in scan 6's file set, with a floor asserting it is non-empty. It is not added to `API_RUNTIME`, which scans 1-3 share and which means "what `next build` compiles".
2. **Stale comments** (`service-verify.ts`: an MCP legacy prefix; `sentry.server.config.ts`: "the frontend"). Accepted and fixed; the WhatsApp exchange comment names its two legacy prefixes.

Fixed in 5e47e104.
