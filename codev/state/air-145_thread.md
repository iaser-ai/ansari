# air-145 — prototypes/ansari-expo sample-citation demo: orphaned footnote pills

## Task

Issue #145: the khushu' demo attached `SAMPLE_CITATIONS` to `message.citations`
but never touched `message.content`, so `AnswerProse`'s `[N]`-marker parser
found nothing to link to the footnote pills — three orphaned pills, no inline
markers.

## Approach

Considered and rejected: heuristic keyword-matching to inject `[N]` into the
*real* apps/api answer text. Rejected because that text is arbitrary
LLM output we don't control — no reliable way to find "the sentence a
citation supports" in it, and a failed match would silently misplace or
cluster markers. Went with the same pattern `SAMPLE_CITATIONS` itself already
uses: a fixed, documented, illustrative constant.

Added `SAMPLE_ANSWER_CONTENT` to `lib/sample-citations.ts` — a fixed answer
paragraph with literal `[1]`/`[2]`/`[3]` embedded at the sentence each sample
citation supports. `mapConversationDetail` in `lib/api/mappers.ts` now
overwrites that one gated message's `content` with it, alongside attaching
`SAMPLE_CITATIONS` — same "illustrative, not real API output" caveat.
Everything else (follow-ups, non-khushu threads) keeps real content
untouched.

## Verification

- `lib/api/decode.test.ts`: new/extended tests assert content rewrite happens
  only on the gated message, and that `lib/markdown.ts`'s `parseAnswer`
  actually parses the embedded markers into footnote spans `[1,2,3]` matching
  `SAMPLE_CITATIONS` marker order — ties the fixture text to the real parser,
  not just a string-contains check.
- Full prototype suite: 221/221 passing. `tsc --noEmit`: clean.

## Gotcha for future builders in this worktree

`porch check`'s `build` criterion runs the full monorepo `turbo build`,
which includes `apps/api` (Next.js). That build fails env validation
(`DATABASE_URL`, `JWT_SECRET`, `KALEMAT_API_KEY`, `USUL_API_TOKEN`) unless
`apps/api/.env` exists locally — it's gitignored and not present by default
in a fresh worktree. `apps/api/.env.ci` is the documented "no-secrets"
dummy-value source; `cp apps/api/.env.ci apps/api/.env` fixes `porch
check`/`porch done` builds without touching anything tracked. Unrelated to
this issue's scope (prototype-only), just a prerequisite to get the build
gate green.

## Outcome

PR #146 opened against `develop`. 65 LOC total (3 files: `sample-citations.ts`,
`mappers.ts`, `decode.test.ts`). `pr_exists` and `e2e_tests` porch checks pass.
