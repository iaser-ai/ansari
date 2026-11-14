### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Phase 2 is well implemented, but one approved acceptance criterion is explicitly weakened.
- gemini: APPROVE — Phase 2 cleanly implements the `/api/service/verify-key` route, shared relation check, generalized alerts, and comprehensive PGlite/Sentry/upgrade-guard tests in full alignment with the spec and plan.

### Builder Response to Iteration 1
# Phase 2, iteration 1: rebuttals

## Codex (REQUEST_CHANGES)

**Point: an expired key's row is deleted (`kept: false`), while spec scenario 2 says each refused row is kept.**

Agreed on the fact, and the test states it rather than hiding it. What I did not do is weaken the route: the deletion is the api-key plugin's own behaviour, not something the route chooses.

- `@better-auth/api-key` 1.7.7 `validateApiKey` deletes a key whose `expiresAt` has passed, before throwing `KEY_EXPIRED` (`dist/index.mjs` L1635–1661). The only setting that changes this is `deferUpdates`, which still deletes, just in the background. Keeping the row would mean patching the plugin or swapping its storage, and neither is in scope.
- The answer is unaffected: an expired key still gets the byte-identical `{"valid":false}`, which is what apps/api relies on.
- In practice no `ansari-mcp` key expires. The script refuses any `--expir*` flag (spec 329), and keys are made only by the script. An expired key can exist only if someone edits the row by hand.
- The row-kept rows that matter operationally are kept and tested: disabled, exhausted (and served again after its daily refill, per the success criterion "an exhausted key is refused until its daily refill, and the row is kept"), and rate-limited.

**What changed:** nothing in code. The test pins the plugin's actual behaviour (`kept: false` for expired, with a comment saying why), so a plugin change that stopped deleting would show up there too.

**Spec wording:** scenario 2's "with each row kept" is wrong for the expired case. Amending an approved spec is the architect's decision, so I have asked the security architect to approve a one-line correction: "with each row kept, except an expired key, which the plugin deletes when it is presented". The review will record this either way. Phase 2 does not claim scenario 2 passes word for word: it passes for every case except that one.

## Gemini (APPROVE)

No issues raised.

## Resolution (2026-11-11, security architect)

The security architect approved the amendment as a plugin fact needing no owner gate. Spec scenario 2 now reads "with each row kept, except an expired key, which the plugin deletes when it is presented (validateApiKey, @better-auth/api-key 1.7.7; pinned by test)", with a dated "Amendment 1" note under the spec's title and in its References. The test now asserts that the expired key's row is gone and every other refused row is kept, so a plugin change either way fails loudly.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
