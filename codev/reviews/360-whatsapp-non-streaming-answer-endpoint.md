# Review: Non-streaming WhatsApp answer endpoint

## Review scope

This review records the changes made for PR #446 review feedback. The spec defines the expected behavior; the plan records implementation decisions and the remaining acceptance checks.

## Findings and changes

### Conversation safety

- Thread selection, creation, initial user-message storage, and the matching history snapshot now occur in one per-user locked transaction.
- A completed answer is saved only if its original thread still exists. If expiry replaces that thread while generation is in progress, the endpoint still returns the answer without attaching it to the newer conversation.
- A new PostgreSQL integration test starts two requests together and delays the first thread insert so the unprotected race would create duplicate threads. The API CI job now provides a dedicated PostgreSQL service for this test.
- An oversized inbound message is rejected before creating or replacing a thread, including on a user's first message.

### Answer and failure handling

- The API stores validated answer text in readable form instead of storing the JSON wrapper.
- Tool-use records are retained when the model returns empty or invalid final output.
- Production logs and monitoring receive only safe error summaries; raw details remain available only in the local development environment.
- An unreadable expiry preference falls back to the configured default. Authentication failures are not swallowed.
- Expiry accepts only whole hours from 0 to 24.

### WhatsApp delivery

- Oversized answer parts are split at sensible text boundaries without splitting Unicode characters.
- The service refuses answers that would need more than 10 outbound messages before sending any answer parts. A Meta rejection during delivery triggers the existing failure-notice path.

### Deferred product questions

- The `/expiry` command's slash suggestions have not been verified for a new user or for an existing user after clearing the chat.
- The introduction and history-limit guidance need product decisions and remain separate follow-up work; see the unpublished draft in the owner's local `tmp/` folder.
- The persistence timing comparison is tracked in issue #447.
- No live model call was made, so real-model JSON output combined with tool use remains unverified.

## Verification

- Focused API regression run: 16 selected test files; 193 passed, 2 skipped. The skips are the PostgreSQL-only integration cases because no `POSTGRES_TEST_URL` was available locally.
- Full API run: `pnpm test --reporter=dot` with the dummy `apps/api/.env.ci` values loaded; 1,411 passed, 55 failed, 5 skipped. The failures are in Windows path/fixture behavior and documentation assertions outside this feature; they are described in a local issue draft and are not all confirmed to share one cause.
- WhatsApp service: `pnpm test` passed, 853/853.
- API: `pnpm run lint` passed with 0 errors and 5 existing warnings; `pnpm run typecheck` passed; `pnpm run build` passed.
- WhatsApp service: `pnpm run lint`, `pnpm run typecheck`, and `pnpm run build` passed.
- CI has not yet run against this uncommitted review revision. The PostgreSQL concurrency test's first CI result is therefore pending.
