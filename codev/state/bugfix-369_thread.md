# bugfix-369 thread

## Investigate
- Root cause: `apps/mcp/test/react-answers.ts` `ATTRIBUTION` (used by ANSWER_A, the answer whose attribution link
  browser.ts clicks) still reads `[ansari.chat](https://ansari.chat)`. So the openLink checks in `apps/mcp/test/browser.ts`
  (lines ~241, 310, 319, 327) exercise the legacy target, not production's `askansari.ai`. The image-consent answer (~759)
  also closes with the old domain.
- Legacy coverage that stays: ATTRIBUTION_CASES (quote/list/followed/emphasis) keep `ansari.chat`; the emphasis case is the
  positive legacy-domain footer case. ANSWER_B already carries `askansari.ai`, so both domains stay covered as footers.
- Scope: tests only, ~6 lines.

## Fix
- `ATTRIBUTION` → `[askansari.ai](https://askansari.ai)`; browser.ts reading-order + three openLink expectations → `https://askansari.ai/`;
  image-consent answer closes with askansari.ai. ATTRIBUTION_CASES keep ansari.chat (comment says why).
- Verified: unit 142/142; browser 73 checks, 0 errors. Regression: old fixture + new expectations fails at
  `answer-A:question-and-text-in-order`.
- Surprises: (1) `pnpm mcp build` does not build `dist-worker/`; without `pnpm --filter ./apps/mcp build:worker` the
  unit suite HANGS (0% CPU, 55 min) in parity-workers.test.ts instead of failing. (2) Playwright chromium-headless-shell
  1248 was not installed; `npx playwright install chromium` fixed it.
