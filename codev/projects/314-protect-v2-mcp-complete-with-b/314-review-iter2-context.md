### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Strong security implementation, but malformed bearer values are misclassified as authentication-service outages and review artifacts are uncommitted.
- gemini: APPROVE — Complete, well-tested implementation of ansari-mcp API key verification across apps/auth and apps/api with fail-closed semantics, strict attribution, and comprehensive documentation.

### Builder Response to Iteration 1
# Review (PR #372), iteration 1: responses

## Codex (REQUEST_CHANGES)

1. **A bearer token over 256 characters or containing non-ASCII reaches apps/auth, which answers 400. apps/api maps that to a 503 outage, but it should be a 401 with no call.** Accepted and fixed.
   - `apps/api/lib/auth-service/client.ts` gains `SERVICE_KEY_MAX_LENGTH` (256, apps/auth's `VERIFY_KEY_MAX_LENGTH`) and `isServiceKeyShape` (`[\x21-\x7E]{1,256}`).
   - The route's `bearerOf` treats any token outside that envelope as `missing`: 401, no apps/auth call.
   - New POST and GET tests: a 257-character token, a non-ASCII token and a DEL token each get 401 with no fetch. A 256-character token at the bound is sent to apps/auth.
   - Mutation check: with the shape check disabled, the 6 new refusal tests fail.
2. **The Phase 1–5 consultation outputs were untracked.** Accepted. This repo commits them (other projects' `codev/projects/*` consult files are tracked). They are committed with this fix.

## Gemini (APPROVE)

No issues raised.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
