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

*(filled in during the design phase)*

## Environment & Reproduction

*(filled in when the harness exists)*

## Code

*(filled in when the harness exists)*

## Results

*(pending the credentialed run; the owner runs it and hands back the results file)*

## What Worked / What Didn't

## Next Steps
