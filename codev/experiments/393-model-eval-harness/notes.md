# Experiment 393: Facilitator model comparison and a reusable evaluation harness

**Status**: Complete. The owner approved merging the harness and report (relayed 2026-11-16); which model to deploy remains the owner's decision · **Date**: 2026-11-15

Source: issue #393. No spec file exists for this project; the issue is the spec.

> **Moved since (issue #397).** The harness now lives in `apps/eval/` as the package
> `ansari-eval`, with its tests in `apps/eval/tests/`. The paths and commands in these notes
> are the ones that were true at the experiment's revision (`apps/api/eval/`,
> `pnpm --filter ansari-api …`) and no longer run as written. The current commands are in
> `apps/eval/README.md`.

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
to the bill. Adding one later is one more id in `--models`. (What it turned out to cost:
about $2 to $3 a run; see Results.)

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
- Tests: `pnpm --filter ansari-api exec vitest run tests/model-eval` (141 tests, no
  credentials).
- Rescore a results file, or check that the scorer would catch a misquote in it, without
  calling a model: `eval/rescore.ts` and `eval/selfcheck.ts` (see the README). The
  committed results are gzipped: `gunzip -k results/<run id>.json.gz` first.

Checked without credentials: the scorers and the report against fixtures; the runner
against a scripted facilitator; and the real import path once with the placeholder
credentials in `.env.ci`, which recorded the expected Vertex error row with the right
provenance and wrote both files. At that point no scorer had seen a real model answer;
what happened when they did is under Results, "Scorer corrections".

## Code

- Seam: `apps/api/lib/facilitator/agent.ts` (`model` option), `apps/api/lib/ai/gemini-client.ts`
  (`noModelFallback`); tests in `apps/api/tests/facilitator-pinned-model.test.ts` and
  `apps/api/tests/gemini-fast-failover.test.ts`.
- Harness: `apps/api/eval/` (`run.ts`, `rescore.ts`, `selfcheck.ts`, `lib/`, `questions/v1.json`,
  `models.json`, `README.md`).
- Harness tests: `apps/api/tests/model-eval/`.
- Described in `codev/resources/arch.md`, "Gemini facilitator & message history".

## Results

Two runs of question set v1 (41 questions, 46 turns) over the three models, both on
2026-11-15, run by the architect with credentials. Reports and compressed results files are
in `results/` beside this file.

| Run | Id | Parallel conversations | Answered / asked |
|---|---|---|---|
| 1 | `20261115-194357-74223bc3` | 4 | flash 37/46, hydrogen 41/46, argon 21/46 |
| 2 | `20261115-202431-b1ff309c` | 1 | 46/46 for all three |

Run 1 is good evidence for what the models wrote and bad evidence for how fast or reliable
they are: see "The environment stalled". Run 2 is the clean one. Both are scored with the
final scorers (`eval/rescore.ts`; no model is called to rescore).

### Recommendation

1. **Production: stay on `gemini-3.7-flash`.** Nothing measured here is a reason to leave
   it. It made no failed Quran quote in 276, cited no `LK id` that a search had not
   returned, and answered every question in its language. It is the fastest and the
   cheapest of the three.
2. **Staging: `gemini-4-hydrogen` is the only candidate that passes every gate**, in both
   runs, so by the criteria fixed before the run it is the one to trial. What it costs:
   about 2.5 times the baseline per answer today ($22.89 against $9.01 per 1,000 answers),
   and about 1.3 times slower to finish an answer (12.6 s against 9.8 s median; the first
   words arrive just as fast). What it gives that was measured: it never quoted a verse it
   had not retrieved (0 of 289 quotes; flash did 9 times, argon 5), and it cites more
   hadith. Whether its answers are *better* is not something this harness measures; that is
   what a staging trial is for.
3. **`gemini-4-argon`: no.** It fails latency in the clean run (10.3 s to first words
   against 4.9 s; 37.1 s to finish against 9.8 s) and reliability in the loaded run (21 of
   46 turns timed out, mostly on the 120 s request budget, because its answers are long).
   It costs 4.3 times the baseline now and its price is reported to double on 2026-12-01.
   Its quotes were as accurate as the others'.
4. **A prompt or code change is called for, whichever model runs** (H2, below). Every
   model quotes Quran text without searching for it on follow-up turns, and flash and argon
   also do it on first turns. All of those quotes were correct this time. The staging
   misquote that started this experiment was exactly this path with a weaker model.
   Follow-up issue: #394.
5. **Not a model question, but found here:** the Vertex project the runs used stalls at
   four parallel conversations. See "The environment stalled".

No deployed setting was changed. `GEMINI_MODEL` is the owner's decision.

### Comparison (run 2, one conversation at a time)

| Measure | gemini-3.7-flash | gemini-4-hydrogen | gemini-4-argon |
|---|---|---|---|
| Turns answered / errors | 46 / 0 | 46 / 0 | 46 / 0 |
| Quran quotes scored | 148 | 151 | 220 |
| … failed (text mismatch or wrong reference) | 0 | 0 | 0 |
| … listed for reading, read, all correct | 1 | 0 | 3 |
| Expected verses quoted correctly | 21 of 21 | 21 of 21 | 21 of 21 |
| `LK id`s cited / not from any search | 40 / 0 | 49 / 0 | 67 / 0 |
| Hadith grade stated: agrees / contradicts / not stated | 32 / 0 / 8 | 34 / 0 / 15 | 67 / 0 / 0 |
| Answers in the question's language (Arabic questions) | 46/46 (7/7) | 46/46 (7/7) | 46/46 (7/7) |
| Time to first words: median / p90 | 4.9 s / 8.2 s | 4.6 s / 17.4 s | 10.3 s / 19.8 s |
| Time to finish: median / p90 | 9.8 s / 19.0 s | 12.6 s / 27.7 s | 37.1 s / 68.2 s |
| Tool calls per answer | 1.3 | 1.7 | 2.0 |
| Tokens per answer: input / output / thinking | 6435 / 1109 / 8 | 7155 / 1250 / 371 | 7746 / 2364 / 0 |
| **Cost per answer** | $0.0090 | $0.0229 | $0.0391 |
| **Cost per 1,000 answers** | $9.01 | $22.89 | $39.13 |
| … relative to the baseline | 1.00x | 2.54x | 4.34x |
| Cost per 1,000 answers after announced price changes | $18.03 | $22.89 | $78.27 |
| … relative to the baseline, both after their changes | 1.00x | 1.27x | 4.34x |

Run 1 gives the same picture on what was written: failed quotes 0 / 0 / 0 of 128 / 138 /
83; `LK id`s not from a search 0 of 34 / 47 / 29; every answer in its language; cost per
1,000 answers $9.56 / $22.90 / $32.11.

Across both runs: 276 / 289 / 303 Quran quotes scored, none failed, for flash / hydrogen /
argon.

### Cost: the price inputs, and how far to trust them

| | gemini-3.7-flash | gemini-4-hydrogen | gemini-4-argon |
|---|---|---|---|
| Price used, US$ per 1M tokens, input / output | 0.75 / 3.75 | 1.50 / 7.50 | 2.00 / 10.00 |
| Confirmed on the Vertex AI pricing page | **No** | **No** | **No** |
| What it was checked against | Web search only | Gemini Developer API pricing page, read 2026-11-15 | Gemini Developer API pricing page, read 2026-11-15 |
| Announced change | 1.50 / 7.50 from 2027-01-01 | none shown | 4.00 / 20.00 from 2026-12-01 |

- **The baseline's price is the weakest number.** `gemini-3.7-flash` is not on the
  Developer API pricing page. The figure I found by web search is identical to that page's
  price for `gemini-3.8-flash`, so the search may have returned the wrong model's price.
  Every "times the baseline" figure rests on it. The GCP billing report for the production
  project has the rate actually charged. Set it in `eval/models.json` and rescore.
- An answer is one facilitator request: every model call of the turn. Thinking tokens are
  billed at the output price. Input is costed at the full input price; the facilitator
  does not report cached-input tokens, so any caching discount makes the real bill lower.
- The dollar figure is for this question set. Production has a different mix and longer
  histories, so the ratio between models is the more portable number.
- Hydrogen costs more per answer for two reasons, both visible above: its price is twice
  flash's, and it spends about 370 thinking tokens per answer where flash spends 8.
- The two runs together cost about $5.20 at these prices.

### Gates (fixed before the run; baseline `gemini-3.7-flash`)

| Gate | hydrogen, run 1 | hydrogen, run 2 | argon, run 1 | argon, run 2 |
|---|---|---|---|---|
| G1 Quran fidelity | pass (0 vs 0) | pass (0 vs 0) | pass (0 vs 0) | pass (0 vs 0) |
| G2 Hadith ids | pass (0) | pass (0) | pass (0) | pass (0) |
| G3 Language | pass (41/41) | pass (46/46) | pass (21/21) | pass (46/46) |
| G4 Reliability | pass (4+1 vs 8+0) | pass (0 vs 0) | **FAIL** (21 vs 8) | pass (0 vs 0) |
| G5 Latency | pass | pass (4.6 vs 4.9 s; 12.6 vs 9.8 s) | pass (all models stalled) | **FAIL** (10.3 vs 4.9 s; 37.1 vs 9.8 s) |
| G6 Cost (reported, not gated) | 2.39x, flagged | 2.54x, flagged | 3.36x, flagged | 4.34x, flagged |

### The hypotheses

- **H1 holds.** `gemini-4-hydrogen` is no worse than the baseline on scripture fidelity,
  citation validity and language, at acceptable latency. `gemini-4-argon` fails one gate
  in each run.
- **H2 holds in its first half; its second half could not be tested.** Models do quote
  Quran on follow-up turns without a fresh search. Share of follow-up Quran quotes not
  backed by a search in the same turn, run 2: flash 4 of 12, hydrogen 10 of 14, argon 12
  of 22 (run 1: 4 of 12, 6 of 10, 2 of 2). All are above the one-quarter threshold fixed
  beforehand, so the prompt or code change is recommended. Most of those re-quote a verse
  an earlier turn had retrieved. The ones that matter more are quotes of a verse **no
  search ever returned**, written from the model's memory: flash 7 in run 1 and 2 in run 2
  (2:256 and 3:159 in full on follow-up turns with no tool call at all; 17:24, 2:157 and
  31:17 on first turns), argon 1 and 4, hydrogen none in either run. Every one of them was
  correct, so there is no error for the second half of H2 to concentrate anywhere.
- **H3 is not falsified.** Every Arabic question was answered in Arabic by every model in
  both runs (7 turns each; argon answered 3 of them in run 1). That fits the report having
  been the fine-tune. It does not prove it: the fine-tune was not tested here.

### The environment stalled at four parallel conversations

In run 1 the first four requests were normal (flash: first event at 1.9 s, done at 7.8 s).
Within a minute every model, the production baseline included, took 10 to 56 s to return
its first tool call and 35 to 95 s per answer, on prompts of about 5,000 tokens. Search
calls stayed near 1 s. 33 of 138 turns timed out (flash 8, hydrogen 4, argon 21): the 60 s
no-response watchdog and the 120 s request budget. There were no 429s. Run 2, identical
but one conversation at a time, had no error and a 9.8 s median for flash.

So the stall follows the parallelism, not the model. I could not see why from here (no
credentials, by design). If the production project shares that quota or location, four
people asking at once is enough to cause user-visible timeouts on today's model. Worth
checking before any model change, and before trusting a load test.

One model difference does show under load: argon's long answers run out the 120 s budget
far more often than the others'.

### Scorer corrections after the first real answers (declared)

The scorers had only ever seen fixtures I wrote. On real answers they were wrong, mostly in
one direction: failing quotes that are not misquotes. I read every flagged quote in both
runs against the raw answer. Counts of failed Quran quotes, as each run first scored
itself and now:

| | flash | hydrogen | argon |
|---|---|---|---|
| Run 1, as first scored | 1 | 7 | 26 |
| Run 1, final scorers | 0 | 0 | 0 |
| Run 2, as first scored (some corrections already in) | 0 | 0 | 11 |
| Run 2, final scorers | 0 | 0 | 0 |

What was wrong, each fixed with a regression test built from the real answer and paired
with a misquote that must still fail (`tests/model-eval/real-answers.test.ts`):

1. The ornate brackets ﴿ ﴾ were treated as letters, so `﴿verse﴾ الآية` was one quote with
   a wrong last word.
2. Arabic tafsir, fiqh and hadith text (in the prose and in those sources' citation
   entries) was compared with the nearest Quran reference. It is now set aside when it is
   the text a search returned, or sits in a citation entry not headed with a Quran
   reference.
3. A wrong reference was called from any reference in the paragraph. It now needs the
   reference on the quote's own line and in its sentence; otherwise the quote is listed
   for reading.
4. Urdu translations of verses, in Urdu answers, were compared with the Arabic verse.
5. A verse fragment copied from a tafsir or hadith result counted as written from memory.
6. A short English answer (a verse and its translation) read as "language undetermined".
7. **One error in the other direction, found by the self-check below:** a corrupted verse
   that a retrieved hadith or tafsir also cites was set aside as that source's text. A
   quote that is plainly an attempt at a verse it is labelled with now fails first.

The gates did not change. G1's "the verse they are labelled with" is now read strictly: a
reference on the quote's line, heading its citation entry, or named near a text that is
plainly an attempt at that verse.

**Does "no failed quotes" mean anything?** `eval/selfcheck.ts` takes every answer with a
correctly quoted verse of five words or more, corrupts that one quote two ways (swaps two
neighbouring words; drops one), and scores it again. Over both runs: 330 corruptions, 329
failed, 1 listed for reading, 0 missed. Before correction 7 it missed some; that is how
the hole was found.

Quotes the final reports list for reading, all read, none a misquote or a wrong
attribution: an alef-only spelling difference (`وَيَا آدَمُ` against 7:19); a hadith
narrator chain near a verse reference; 2:157 quoted from memory in standard spelling with
only "verse 157" as its label (checked against the retrieved text of 2:157: correct);
three verse fragments, each correct, in a line or paragraph that names a different verse.

### What this does not show

- One or two samples per question. Zero failed quotes in about 280 per model bounds the
  per-quote failure rate below roughly 1 percent, no lower. A rare misquote is not ruled out.
- Whether an answer is good: complete, well reasoned, right in its fiqh. Only whether what
  it quotes and cites is real.
- A Quran quote with no reference near it and no matching verse in hand is not scored. In
  an answer written in Arabic, only quoted or vowelled Arabic is read as a quote.
- Hadith text is not compared with its source, only the `LK id` and the grade.
- The fine-tune that misquoted on staging was not run.

## What Worked / What Didn't

- **Worked:** pinning a request to one model and running `runFacilitator` in process. No
  database, no server, and every row is attributable. Storing looked-up verses and raw
  tool records in the results file: every scorer correction was applied to both runs
  without another model call.
- **Worked:** interleaving the models question by question. When the environment stalled,
  it stalled for all three alike, so run 1 was still comparable on content.
- **Didn't:** scorers tested only on fixtures I wrote. They passed 115 tests and were wrong
  on the first real answer. What made them trustworthy was reading real flagged quotes and
  then corrupting real correct ones. The self-check should have been written first.
- **Didn't:** my cost estimate ($6 a run). Prompts are about 6,500 tokens, not 20,000. A
  run costs about $2 to $3.
- **Didn't:** confirming prices. The Vertex pricing page would not load for me or for the
  architect.
- **Surprise:** the stall at four parallel conversations.

## Next Steps

1. Owner decides the staging and production models from the recommendation above.
2. #394: Quran text in an answer should come from a search result (prompt rule, a check
   in code, or both). Filed as issue #393 asks when the results point to a fix.
3. Confirm the three prices, the baseline's first, from the Vertex pricing page or the GCP
   billing report; set `confirmed` in `apps/api/eval/models.json`; rescore.
4. Find out why the Vertex project stalls at four parallel conversations, and whether
   production shares that limit.
5. If a second opinion on hydrogen is wanted before production: re-run with `--repeats 3`
   on the near-identical and follow-up categories (`--only category:near-identical`), and
   add `gemini-3.8-flash`, which is priced like the baseline.

## Flaky Tests

`tests/migration/window-migration.test.ts > 0009 scaffold cleanup (scenario 15) > aborts on
a row in any single scaffold table` timed out once (30 s limit) in a full local run of the
apps/api suite while other builders were using the machine, and passed when run on its own.
This branch does not touch it or anything it imports. Not skipped: one timeout under load
is not enough to disable a migration guard.

A second full run before the PR (1452 passed) failed the same test again and also
`tests/contract/legacy-users-contract.test.ts > POST /v2/users/login > finds a lowercase
row from a mixed-case email`. Both passed when the two files were run on their own (73 of
73), and this branch touches neither. Both look like timeouts when the whole suite runs in
parallel on a busy machine; CI is the place to see whether they are flaky there.
