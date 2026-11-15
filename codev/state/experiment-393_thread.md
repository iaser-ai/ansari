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
