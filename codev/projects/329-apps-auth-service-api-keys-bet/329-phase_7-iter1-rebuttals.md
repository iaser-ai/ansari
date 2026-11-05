# Phase 7, iteration 1: response to review

## Codex (REQUEST_CHANGES): the docs name `WHATSAPP_KEY_BOUNDS` but not its ranges

**Accepted and fixed.** The phase asked for the `limits.ts` bounds, and the docs gave only the
constant's name. The test checked only that the constant exists, so it could not catch this.

- `docs/self-hosting.md` now states the inclusive ranges: `--rate-max` 1 to 100,000,
  `--rate-window` 1 second to 24 hours, `--daily` 1 to 10,000,000.
- `docs/cutover/service-keys-runbook.md` (Limits) has a table of the accepted ranges per flag,
  and says that an out-of-range value is refused with nothing written.
- Tests compute the expected text from `limits.WHATSAPP_KEY_BOUNDS` instead of checking that
  the key exists: `self-hosting-docs.test.ts` ("states limits.ts's values as they are") and a
  new `cutover-docs.test.ts` test ("gives the script's accepted ranges as WHATSAPP_KEY_BOUNDS
  defines them").
- Negative run: a wrong upper bound in each doc (`--daily` 1,000,000 in the runbook,
  `--rate-max` 10,000 in self-hosting) → both tests red (2 failed, 115 passed); restored →
  117 passed.

The "working tree changed" notice in both reviews named only
`codev/projects/329-*/.codex-run.log` and `.gemini-run.log`: the stdout logs of my own
background consult run, not consultant writes. They are deleted and not committed.

## Gemini (COMMENT)

The lane was skipped (agy exit 3), as in every earlier phase. Non-blocking; nothing to address.
