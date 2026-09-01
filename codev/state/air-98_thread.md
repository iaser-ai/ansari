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
- Battery running; results to be attached to the PR body.
