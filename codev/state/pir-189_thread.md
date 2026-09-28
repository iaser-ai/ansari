# pir-189 thread — paced reveal of streamed answer

- 2026-09-26 plan: reveal as a new hook (`hooks/useRevealedText.ts`) + pure core (`lib/reveal.ts`)
  layered on `streamingText`; onEvent untouched (architect: #128/PR #188 and #161 touch same files,
  keep additive, merge develop + re-verify before PR). Key finding: `stripStreamingCitations` output
  is NOT append-only, so reveal clamps to common prefix. Hand-off gated on reveal caught up;
  reveal accelerates to ~150ms drain once stream settles.
- 2026-09-28 implement: session had paused on a usage limit after plan approval; architect pinged,
  resumed. Merged origin/develop (#128/PR #188) first — reconciler now also takes pendingFollowUp;
  passing revealedText as its `streamingText` input is still safe. Added lib/reveal.ts (+15 tests),
  hooks/useRevealedText.ts (+6 jsdom tests; vitest include now covers hooks/). Footer switched to
  revealedText so ThinkingLine→bubble hand over in the same frame. Mutation-checked: disabling
  catch-up fails the lag test; dropping the same-render clamp fails the pull-back test (the first
  version of that test did NOT catch it — rerender flushes effects; fixed by recording every render).
  Not run against the live staging API (no credentials) — manual check left to dev-approval.
