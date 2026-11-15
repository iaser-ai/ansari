# Experiment 393: Facilitator model comparison and a reusable evaluation harness

**Status**: In Progress · **Date**: 2026-11-15

Source: issue #393. No spec file exists for this project; the issue is the spec.

## Goal

Decide which Gemini model Ansari's facilitator should run on (staging first, then
production), and leave a harness that re-runs the same comparison for any future model.

Candidates: `gemini-3.7-flash` (production today, the baseline), `gemini-4-hydrogen`,
`gemini-4-argon`. Optional if cheap: `gemini-3.8-flash`, `gemini-4-carbon`.

### Hypotheses (written before any harness code or model call)

- **H1 (the decision).** At least one of `gemini-4-hydrogen` / `gemini-4-argon` is no worse
  than `gemini-3.7-flash` on scripture fidelity, citation validity and language adherence,
  at acceptable latency. Falsified if every candidate fails one of the gates below.
- **H2 (the prompt gap).** On follow-up turns, models quote Quran text without a fresh
  `search_quran` call, and text errors concentrate in those ungrounded quotes.
  Falsified if every Quran quote on the follow-up questions is backed by a search result
  from the same turn, or if ungrounded quotes show no higher error rate than grounded ones.
- **H3 (the language report).** The "Arabic question answered mostly in English" report was
  the fine-tune, not Gemini. Falsified if any Gemini model fails the language check on an
  Arabic question.

### Success criteria, fixed now

A candidate is recommended for staging only if it passes **every** gate against the
baseline measured in the same run:

| Gate | Measure (all by code) | Pass when |
|------|----------------------|-----------|
| G1 Quran fidelity | Quotes whose text does not match the retrieved text of the verse they are labelled with (`mismatch`), or that match a different verse than the label (`wrong_reference`) | Count ≤ baseline's count, and every such quote is listed in the report with its diff |
| G2 Hadith ids | `LK id` tokens that appear in no search result of the conversation (`fabricated`) | 0 |
| G3 Language | Share of answers in the question's language | ≥ baseline's share, and no Arabic question answered in another language |
| G4 Reliability | Error, empty or budget-synthesis outcomes | ≤ baseline's count + 1 |
| G5 Latency | Median time to first token, median total time | Each ≤ 1.5 × baseline |
| G6 Cost | Mean cost per answer | Reported, not gated; flagged above 2 × baseline. The owner decides |

Production is recommended only for a model that passes on staging first; this experiment
can recommend a staging candidate and nothing further.

For H2: the prompt or code change is recommended if any model produces an ungrounded Quran
quote with a `mismatch` or `wrong_reference`, or if more than a quarter of Quran quotes on
follow-up turns are ungrounded.

### What this run cannot show

One sample per question per model, roughly 40 turns each. Zero failures in 40 trials only
bounds the true failure rate below about 7% (rule of three), so the run can reject a model
but cannot certify a rare misquote away. The report states counts, not just verdicts, and
the harness takes `--repeats` for a larger run on the categories that matter.

## Approach

Design decisions, made before any model call. The hypotheses and gates above were committed
first (`36efd792`) and have not been edited since.

**One seam into the facilitator.** `runFacilitator(history, onMessage, { model })` pins a
request to one Gemini model: every call targets it, the cross-model 429 failover is off
(`noModelFallback`), and the request never escalates to Inkling. Without that, an answer
recorded under `gemini-4-argon` could have been written by the fallback model. A pinned
model that cannot answer is recorded as an error. No route passes `model`; the public API is
untouched.

**In process, not over HTTP.** The harness calls `runFacilitator` directly, so it needs no
database, no auth service and no running server, and it reads the same terminal event
(usage, tool-call records, provenance) the chat route persists. Follow-up turns replay
history the way the route does.

**Ground truth is Kalimat's text, not the model's and not mine.** A Quran quote is compared
with the retrieved text of the verse it is labelled with. When the answer names a reference
no search returned (a quote from memory), the runner looks that verse up through the same
`search_quran` tool and stores it in the results file, so every score can be recomputed
offline (`eval/rescore.ts`).

**Three levels of Arabic comparison**, because Kalimat returns Uthmani script and models
often retype in standard spelling: as written, standard spelling (documented folds in
`eval/lib/arabic.ts`), and ignoring alefs. The first two pass. An alef-only difference is
listed for a human and does not count against the gate. Anything else is `mismatch`. The
staging misquote (بِعَيْنِنَا for بِأَعْيُنِنَا) differs at every level.

**Hard failures are narrow on purpose.** Only `mismatch` (labelled with a verse, text is
not that verse) and `wrong_reference` (text is a different verse than the label) count for
G1. Arabic near a reference that matches nothing in hand is `suspect`; a label that could
not be looked up is `unverifiable`; honorifics and short terms are `term`. Those are
reported and listed, never silently passed as correct.

**Question set v1** (`eval/questions/v1.json`): 41 questions, 46 turns, written for this
experiment, none taken from a user's conversation.

| Category | Questions | | Language | Questions |
|---|---|---|---|---|
| quran-by-reference | 6 | | en | 28 |
| quran-by-topic | 8 | | ar | 6 |
| near-identical | 7 | | fr | 2 |
| hadith-grade | 7 | | id | 2 |
| fiqh | 8 | | ur | 2 |
| follow-up (two turns) | 5 | | tr | 1 |

**Size of the first run.** Three models x 46 turns = 138 facilitator requests, roughly 280
to 550 model calls (each request is one call per tool round plus the final answer), plus a
Kalimat lookup for each from-memory reference. Estimated cost about 6 US dollars, range 5
to 12, at prices found by web search and not confirmed against the live pricing page
(`eval/models.json` says so per model). The optional models (`gemini-3.8-flash`,
`gemini-4-carbon`) are left out of the first run: no confirmed price, and each adds a third
to the bill. Adding one later is one more id in `--models`.

## Environment & Reproduction

- Node >= 22, `pnpm install` at the repo root. No database and no other service.
- Credentials in `apps/api/.env.eval.local` (git-ignored): Vertex project, location and
  credentials, `KALEMAT_API_KEY`, `USUL_API_TOKEN`, a dummy `DATABASE_URL`,
  `ENVIRONMENT=development`. The exact file is in `apps/api/eval/README.md`.
- Run, from the repo root:

  ```bash
  pnpm --filter ansari-api exec -- tsx --env-file=.env.eval.local eval/run.ts \
    --models gemini-3.7-flash,gemini-4-hydrogen,gemini-4-argon
  ```

  Add `--dry-run` to print the plan and call count without calling anything.
- Output: `apps/api/eval/results/<run id>.json` and `<run id>.md`.
- Tests: `pnpm --filter ansari-api exec vitest run tests/model-eval` (115 tests, no
  credentials).

Checked without credentials: the scorers and the report against fixtures; the runner
against a scripted facilitator; and the real import path once with the placeholder
credentials in `.env.ci`, which recorded the expected Vertex error row with the right
provenance and wrote both files. Not checked: any real model answer. The scorers have
never seen one, so the first results file gets read by hand before its gates are believed
(see Next Steps).

## Code

- Seam: `apps/api/lib/facilitator/agent.ts` (`model` option), `apps/api/lib/ai/gemini-client.ts`
  (`noModelFallback`); tests in `apps/api/tests/facilitator-pinned-model.test.ts` and
  `apps/api/tests/gemini-fast-failover.test.ts`.
- Harness: `apps/api/eval/` (`run.ts`, `rescore.ts`, `lib/`, `questions/v1.json`,
  `models.json`, `README.md`).
- Harness tests: `apps/api/tests/model-eval/`.
- Described in `codev/resources/arch.md`, "Gemini facilitator & message history".

## Results

*(pending the credentialed run; the owner runs it and hands back the results file)*

## What Worked / What Didn't

## Next Steps

1. Owner runs the command above with credentials and hands back the results file.
2. Read every quote the report lists as failed, suspect or alef-only against the raw
   answers before believing the gates. If a scorer is wrong, fix it, say so here with the
   before and after counts, and rescore. The gates themselves do not change.
3. Fill in Results with the comparison table, the gate outcomes and the recommendation.

## Flaky Tests

`tests/migration/window-migration.test.ts > 0009 scaffold cleanup (scenario 15) > aborts on
a row in any single scaffold table` timed out once (30 s limit) in a full local run of the
apps/api suite while other builders were using the machine, and passed when run on its own.
This branch does not touch it or anything it imports. Not skipped: one timeout under load
is not enough to disable a migration guard.
