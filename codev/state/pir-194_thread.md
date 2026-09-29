# pir-194 thread

## Plan (2026-09-29)
- Root cause confirmed in code: raw multi-line `grade_en` flows into `sourceTitle`, rendered unbounded in the footnote pill (AnswerMessage) and folio (SourceFolio).
- No multi-grade fixture exists anywhere in repo; parser designed for both newline and inline `1: … 2: …` shapes.
- Plan: client-side `parseGrades`, primary + "(+N more)" in sourceTitle, full list in folio (tap), pill capped at 2 lines. No backend change.

## Implement (2026-09-29)
- Done per plan. Deviation: did NOT add a multi-grade sample to lib/sample-citations.ts — that file forbids entries not verified against a primary source.
- Live grade_en shape still unconfirmed: no Kalimat key in worktree (.env.example/.env.ci only). Parser handles newline and single-line numbered forms; pill capped at 2 lines regardless.
- vitest 297 pass (14 new), tsc clean.
