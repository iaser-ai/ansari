# Model evaluation harness

Runs a versioned question set through the **real facilitator** (its prompt, tools, retries
and budgets) once per model, scores every answer with code, and writes a results file and
a comparison report. Built for issue #393; meant to be re-run whenever a new model appears.

It lives in `apps/api/eval/` because it calls `runFacilitator` in process: beside the code
it measures, typechecked and linted with it, and outside `lib/` and `src/` so no route can
import it. Its tests are in `apps/api/tests/model-eval/` and run with the normal suite.

## Run it

From the repo root, with an env file that holds real credentials:

```bash
pnpm --filter ansari-api exec -- tsx --env-file=.env.eval.local eval/run.ts \
  --models gemini-3.7-flash,gemini-4-hydrogen,gemini-4-argon
```

The `--` after `exec` is required: without it pnpm takes `--env-file` for itself and the
run stops with `node: .env.eval.local: not found`. The env file path is relative to
`apps/api/`.

The first model is the baseline the others are compared against. The run prints one line
per conversation and ends with the two paths it wrote, under `apps/api/eval/results/`:

- `<run id>.json`: inputs, model ids, git revision, dates, every raw answer, the tool-call
  records, the looked-up verses and the scores.
- `<run id>.md`: the comparison report.

`--dry-run` prints the plan and the number of calls without calling anything. A full run
of question set v1 over three models is 138 facilitator requests, roughly 280 to 550 model
calls. Other options: `--repeats <n>` (samples per question), `--only <ids or
category:name>`, `--concurrency <n>` (default 4), `--questions <file>`, `--out <dir>`,
`--verbose`.

### The env file

`apps/api/.env.eval.local` (git ignores `.env.*.local`). The harness reads the same
variables the app does, through `lib/config.ts`:

```bash
# Vertex AI: the models under test are called here.
GOOGLE_CLOUD_PROJECT=<project id>
GOOGLE_CLOUD_LOCATION=global
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json   # or gcloud ADC
# The search tools.
KALEMAT_API_KEY=<key>
USUL_API_TOKEN=<token>
# Required by config validation; the harness never opens a database connection.
DATABASE_URL=postgresql://unused:unused@localhost:5432/unused
ENVIRONMENT=development
```

`GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `PRIMARY_BACKEND` and `TINKER_API_KEY` do not
affect a run: each request is pinned to the model under test (see below).

If the first four conversations all fail, the run stops and prints the error: a wrong
credential or model id should not produce a file of 138 errors.

## What "the real facilitator path" means here

`runFacilitator(history, undefined, { model })`. The `model` option pins the request:
every Gemini call targets that model, the cross-model 429 failover is off, and the request
never escalates to Inkling. Same-model retries, tool calls, budgets and the synthesis pass
all run as in production. So an answer recorded under a model's name was written by that
model, and a model that cannot answer shows up as an error, not as another model's answer.

Follow-up turns replay history the way the chat route does: each earlier answer's text
with the final model turn's raw payload.

## What is scored

All by code; the functions are in `eval/lib/` and each file's header states its rules.

| Measure | How |
|---|---|
| Quran quote matches its source | Every run of Arabic is compared with the retrieved text of the verse it is labelled with (`score-quran.ts`). Letters only, at three levels (`arabic.ts`): as written, in standard spelling, and ignoring alefs. A reference the answer names that no search returned is looked up, so a quote written from memory is still checked. Arabic a tafsir, fiqh or hadith search returned, and Arabic in a citation entry not headed with a Quran reference, is that source's text and is set aside. |
| The reference is right | A quote whose text is a different verse than the reference on its own line (or heading its citation entry) is `wrong_reference`; a question can also list the references its answer should quote (`expectRefs`). |
| Hadith `LK id` came from a search | Every `LK id` token is looked up among the ids `search_hadith` returned in that turn, an earlier turn, or nowhere (`fabricated`). Also: hadith citations with no id, and stated grades that contradict the search result (`score-hadith.ts`). |
| Answer is in the question's language | Script share of the prose, then function words or script-specific letters (`score-language.ts`). |
| Searched before quoting | Per quote: the verse (or the quoted words, inside a tafsir or hadith result) came from a search in this turn, an earlier turn, or none. Per turn: scripture quoted with no result from the matching search tool. |
| Latency, tokens, cost, tools, failures | Time to first event and first visible text, total time; tokens summed over the turn's model calls; cost per answer and per 1,000 answers from `models.json` (see Prices); tool calls and how many returned no source; errors, budget syntheses and retries (read from the facilitator's own log lines, attributed per request). |

The report states counts and lists every failed quote with its diff, every fabricated id,
every answer in the wrong language and every error. A quote fails only when it is labelled:
a reference on its own line, or in its paragraph when the text is plainly an attempt at a
verse in hand. Two buckets are for a human to read, not for the gate: quotes that differ
from their source only by an alef, and `suspect` Arabic (text near a reference that
matches nothing, text resembling a verse with no reference at all, or one verse's text in
a paragraph that names only another).

### Limits, stated

- A Quran quote with no reference near it and no matching verse in hand is not scored.
- In an answer written in Arabic script, only Arabic that is quoted (`﴿ ﴾`, `« »`, `" "`)
  or vowelled is read as a quote; unvowelled, unquoted scripture inside Arabic prose is
  missed.
- Spelling the checker does not fold (open ta for ta marbuta, a silent letter standard
  spelling drops, a dropped hamza) shows up as a mismatch or an alef-only difference, with
  its diff, for a human to judge.
- An errored turn reports no token usage, so it adds nothing to cost.
- One sample per question. Zero failures in n answers bounds the true rate below about
  3/n. Use `--repeats` for more.

## Rescore without calling a model

```bash
pnpm --filter ansari-api exec -- tsx eval/rescore.ts eval/results/<run id>.json
```

Recomputes every score from what the file recorded and rewrites the report. Use it after
correcting a scorer or adding a price to `models.json`.

## Add a model

1. Pass its id in `--models`. Nothing else is needed to run it.
2. For cost, add its price to `eval/models.json` (US dollars per million input and output
   tokens, with where the number came from). A model without a price reports cost as n/a.

### Prices

The report's Cost section gives, per model, the price inputs, the cost per answer and per
1,000 answers, and the ratio to the baseline. Each entry in `eval/models.json` carries:

- `confirmed`: `true` only after a person has checked the numbers against the
  [Vertex AI pricing page](https://cloud.google.com/vertex-ai/generative-ai/pricing). The
  report marks every figure for an unconfirmed model. Put the date you checked in `source`.
- `next` (optional): an announced price change, `{ "from": "2026-12-01", "inputPerMTok":
  4, "outputPerMTok": 20 }`. The report then also costs the run at that price, because an
  introductory rate that ends next month is not the price a decision should rest on.

After editing prices, run `eval/rescore.ts` on the results file: no model is called.

What the cost figure is: model tokens only, at the full input price (the facilitator does
not report cached-input tokens, so a caching discount makes the real bill lower), averaged
over this question set, which is not production's mix of questions.

## Add or change a question

Question sets are files in `eval/questions/`, validated on load (`lib/question-set.ts`).

```json
{
  "id": "near-in-our-eyes",
  "category": "near-identical",
  "language": "en",
  "note": "Why it is in the set.",
  "turns": [{ "text": "The question.", "expectRefs": ["52:48"] }]
}
```

- More than one entry in `turns` makes a follow-up conversation.
- `language` is the language the answer must be in.
- `expectRefs` is optional: the Quran references the answer should quote.

A released set is not edited: copy it to `v2.json`, raise `version`, and change that. The
results file records the set's version and hash, so two runs are comparable only when
both match. Write questions yourself. Do not copy a user's conversation out of a database.

## Tests

`pnpm --filter ansari-api exec vitest run tests/model-eval`. Each scorer is tested against
a known-bad answer it must fail and a near-miss it must pass; the staging misquote
(بِعَيْنِنَا for بِأَعْيُنِنَا, labelled 68:48) is one of the fixtures. The runner, scoring and
report are tested end to end against a scripted facilitator.
