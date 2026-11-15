# experiment-393 thread

## 2026-11-15 — start, hypothesis phase

- The builder prompt names `codev/specs/393-experiment-compare-gemini-4-hy.md`. That file
  does not exist, and the "Protocol Reference (full text)" section was not inlined either.
  Working from issue #393 as the spec and the experiment protocol in the installed codev
  skeleton. Experiment notes: `codev/experiments/393-model-eval-harness/notes.md`.
- Hypotheses and pass/fail gates are committed before any harness code (see notes.md).
- No Vertex or Kalimat credentials here, by design. The harness is built and unit-tested
  against fixtures; the owner runs the credentialed command and hands back the results file.
