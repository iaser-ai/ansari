# pir-189 thread — paced reveal of streamed answer

- 2026-09-26 plan: reveal as a new hook (`hooks/useRevealedText.ts`) + pure core (`lib/reveal.ts`)
  layered on `streamingText`; onEvent untouched (architect: #128/PR #188 and #161 touch same files,
  keep additive, merge develop + re-verify before PR). Key finding: `stripStreamingCitations` output
  is NOT append-only, so reveal clamps to common prefix. Hand-off gated on reveal caught up;
  reveal accelerates to ~150ms drain once stream settles.
