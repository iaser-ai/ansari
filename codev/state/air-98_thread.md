# air-98 thread — Facilitator prompt: never quote scripture from memory (#98)

## 2026-09-01 — implement

- Read issue #98: prompt-only fix (owner rejected a deterministic router rule — baked).
  Target: `apps/api/lib/ai/prompts/facilitator.ts`; acceptance is empirical (12/12
  tool invocation on the taqwabench Quran battery with the weak Gemma sft-dpo primary).
- Wrote the SCRIPTURE QUOTATION RULE section (absolute never-from-memory, all four
  reference shapes: number / name / description / implicit), a FIRST ACTION rule with
  concrete examples, a not-verified-then-say-so rule, and a FINAL CHECK block at the
  very end of the prompt. Also removed the old hadith hedge ("I believe (though not
  100% sure)...") which was an explicit license to recite hadith from memory —
  contradicted the new rule.
- Unit tests added to `tests/facilitator-prompt.test.ts` (7 new tests locking the
  section in). Full suite green.

### Debugging detour worth knowing about

First two pipeline smoke tests showed `tool_calls: NULL` and I nearly concluded the
prompt was too weak. Actual cause: **my branch was missing PR #96** (`PRIMARY_BACKEND`
didn't exist in code — env var silently ignored, server ran Gemini primary) and also
missing the tool_calls persistence code, so NULL was recorded regardless. A direct
probe of the Modal Gemma endpoint with the same prompt text called search_quran 5/5,
which localized the discrepancy to the pipeline, not the wording. Merged
origin/develop (539d29a, clean), and the pipeline smoke test then invoked
search_quran on 36:1 (the scored regression case) and copied the tool text exactly.

Lesson (echo of lessons-critical): before attributing a symptom to the code you are
editing, confirm what revision is actually running — twice in one day.

- Eval setup mirrors the architect's: dev server on port 3001 from this worktree,
  `.env.local` copied from architect's eval-wt (PRIMARY_BACKEND=inkling → Modal
  sft-dpo-bf16, DB ansari_eval on :5434). Battery script:
  scratchpad `run-battery-98.sh` (12 numeric + 6 taqwabench named asks + issue's
  "last two verses of al-Baqarah" + non-regression patience probe).
## 2026-09-01 — battery results (acceptance PASSED)

- **Numeric battery: 12/12 invoked search_quran** (was 4/12). All three former
  failures (36:1, 103:2, 83:1) now answer with the exact retrieved text — verified
  against taqwabench `quranquote/data/quran_truth.json` (NFKD-normalized Arabic
  comparison; truth rows carry a basmala prefix the retrieval rows don't).
- **Named battery: 7/7 invoked search_quran** — the 6 taqwabench
  `quran_truth_named.json` asks (Ayat al-Kursi, Ayat ad-Dayn, last verse of
  al-Baqarah, Ayat an-Nur, Ayat al-Mubahala, first verse of al-Mulk) plus the
  issue's "last two verses of Surah al-Baqarah" (3 calls, one per verse pair need).
- **Non-regression:** "What does Islam say about patience" answered substantively
  with `tool_calls: NULL` — the push stays scoped to producing scripture text.
- Transcripts: builder scratchpad `air98-battery-transcripts.md`; runner
  `run-battery-98.sh` (adapted from architect's run-battery.sh, port 3001).
- Suite green (752 passed / 3 skipped), build + typecheck clean. Skipping CMAP:
  prompt-text-only change; the scored battery is the substantive review.
- Note for architect: on my pre-merge branch the same prompts ran with **Gemini**
  primary (no PRIMARY_BACKEND support yet) and Gemini answered 36:1 from memory
  without tools — tool_calls persistence was also missing there, so that NULL is
  not conclusive. If Gemini-primary compliance matters for prod, worth a separate
  spot-check post-merge; the issue's acceptance was defined on the weak Gemma
  primary only.
