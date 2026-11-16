# experiment-393 thread

## 2026-11-15 — start, hypothesis phase

- The builder prompt names `codev/specs/393-experiment-compare-gemini-4-hy.md`. That file
  does not exist, and the "Protocol Reference (full text)" section was not inlined either.
  Working from issue #393 as the spec and the experiment protocol in the installed codev
  skeleton. Experiment notes: `codev/experiments/393-model-eval-harness/notes.md`.
- Hypotheses and pass/fail gates are committed before any harness code (see notes.md).
- No Vertex or Kalimat credentials here, by design. The harness is built and unit-tested
  against fixtures; the owner runs the credentialed command and hands back the results file.

## 2026-11-15 — design and build done, waiting on the credentialed run

- Seam (`15443a88`): `runFacilitator(..., { model })` pins a request to one Gemini model.
  Pinned means no cross-model 429 failover and no Inkling rung or rescue, so a results row
  is attributable to the model it names. No route passes it.
- Harness (`ad388574`): `apps/api/eval/`, tests in `apps/api/tests/model-eval/` (115).
  Runs in process against `runFacilitator`; no database or server needed.
- Decisions a later reader might question:
  - Quran ground truth is Kalimat's text. References the answer names but no search
    returned are looked up by the runner and stored in the results file, so from-memory
    quotes are still checked and rescoring is offline.
  - Three comparison levels (as written, standard spelling, ignoring alefs). Alef-only
    differences go to a human-review list, not to the gate.
  - Only `mismatch` and `wrong_reference` count for G1. `suspect` and `unverifiable` are
    listed, never passed as correct.
  - Prices in `eval/models.json` came from web search and are marked unconfirmed. Cost is
    reported, not gated.
  - Optional models (3.8-flash, 4-carbon) left out of the first run to keep it near $6.
- Full apps/api suite: 1418 passed, 1 timed out (`window-migration.test.ts` scenario 15,
  passes alone, untouched by this branch; noted under Flaky Tests in notes.md, not skipped).
- Blocked on: the owner running the harness with credentials. Command and estimate sent to
  the architect. Nothing in the scorers has seen a real model answer yet; the first results
  file gets read by hand before the gates are believed.

## 2026-11-15 — first credentialed run in progress (20261115-194357-74223bc3)

- Owner approved the three-model run; the architect runs it with credentials in the
  process environment. Owner requirement added: cost per answer and per 1,000 answers in
  the comparison and the recommendation, price inputs shown and marked confirmed or not.
  Done in `595df47f` (report Cost section; `confirmed` and `next` in `eval/models.json`).
  I could not read the Vertex pricing page from here; all prices are marked NOT confirmed.
- Scorer corrections, declared (`b225ae52`). Read from the partial results file: every one
  of the 18 quotes the scorer failed in the first 21 turns was a scorer error, not a model
  error. Causes: the ornate brackets ﴿ ﴾ were treated as letters, so `﴿verse﴾ الآية` was
  one quote with a wrong last word; Arabic tafsir text (in the prose and in tafsir
  citation entries) was read as Quran and compared with the nearest reference; a tafsir
  entry's English line naming another verse was taken as the entry's label. Also one short
  English answer read as "language undetermined". Each fix has a regression test paired
  with a misquote that must still fail. Gates G1 to G6 are unchanged; G1's "labelled"
  now means a reference on the quote's own line (or its paragraph for a clear attempt at
  a verse in hand), which is what the pre-registered wording says.
- The run environment is slow for all three models after the first minute (10 to 56 s to
  the first tool call, 11 of the first 42 turns timed out, baseline included, no 429s).
  Read as Vertex throttling or load, not a model property. Told the architect;
  recommended letting it finish and running the set again with `--concurrency 1`.
- My cost estimate was high: prompts are 5K to 8K tokens, not 20K. A full run is about $3.

## 2026-11-15 — both runs in, results written

- Runs: `20261115-194357-74223bc3` (4 parallel, 33 of 138 turns timed out, all models
  stalled) and `20261115-202431-b1ff309c` (1 at a time, 138 of 138 answered). Reports and
  gzipped results are in `codev/experiments/393-model-eval-harness/results/`.
- Result in one line: no failed Quran quote, no fabricated LK id and no wrong-language
  answer for any model in either run. hydrogen passes every gate; argon fails latency
  (clean run) and reliability (loaded run). Recommendation: production stays on
  3.7-flash, hydrogen is the staging candidate, argon no. Details and cost table in notes.md.
- H2 action rule triggered (follow-up turns quote Quran without a same-turn search, all
  models; flash and argon also quote verses no search returned). Filed #394.
- More scorer corrections after reading every flagged quote in both runs (Urdu
  translations, a label in the next sentence, set phrases), and one in the other
  direction found by corrupting real answers: a misquoted verse that a retrieved hadith
  or tafsir also cites was being set aside. `eval/selfcheck.ts` is that check, kept:
  330 corruptions over both runs, 329 failed, 1 listed for reading, 0 missed.
- Prices: architect read hydrogen and argon off the Gemini Developer API page (not Vertex).
  3.7-flash is not on that page and my searched figure equals 3.8-flash's, so the baseline
  price is the least certain number; asked for the GCP billing rate.
- Open for the owner, none blocking the PR: confirm prices; why the Vertex project stalls
  at four parallel conversations.

## 2026-11-15 — PR #395 review: one change requested, done

- Reviews: codex APPROVE, claude APPROVE, gemini skipped; CI green.
- Requested: a source-scan test that fails if a route passes `model` to `runFacilitator`.
  Added `apps/api/tests/source-scan/facilitator-model-pin.test.ts` (AST scan, strict: the
  options must be absent or an object literal written at the call with no `model`, no
  spread, no unreadable key). Proven on 11 planted lines and 9 near-misses, and on the
  real tree: planting `{ model }` in the chat route makes it fail (1 hit in 4 calls, 28
  files), restoring it makes it pass. Also scans that nothing under src/lib/db imports
  from `eval/`.
- Not merged, gate not approved: the architect is taking the decision to the owner.

## 2026-11-16 — Owner approved; gate approved, merging

- CI green on 0a4b4bd3 (the source-scan test).
- Architect relayed the owner's decision (made 2026-11-15, relayed 2026-11-16T05:12Z): yes
  to merging PR #395, and the `experiment-complete` gate is approved by the human. I ran
  `porch approve 393 experiment-complete` on that instruction, not before.
- The approval covers merging the harness, question set, README and report. No deployed
  setting was changed by this project; `GEMINI_MODEL` is the owner's to change.
- Left open for others: confirm prices in `apps/api/eval/models.json` (the baseline's
  first) and rescore; #394 (search before quoting on follow-ups); the parallel-stall
  issue the architect filed.
