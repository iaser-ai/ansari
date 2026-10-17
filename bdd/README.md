# Image attachments: local BDD checks

Answers Waleed's review questions on PR #284 with runnable scenarios. They are run by hand only,
never in CI. CI runs turbo on the pnpm workspace packages (`apps/*`, `packages/*`), and this
folder is outside the workspace, with its own npm install. Your `.env`, `node_modules/` and
`results/` are ignored by `bdd/.gitignore`.

## What runs where

- **The API under test** is this checkout's `apps/api`, so check out `feature/image-attachments-api`
  first. It is rebuilt automatically when `apps/api` or `packages/` change.
- **The database** is `ansari_bdd` on your local Postgres (never `ansari_local`).
- **Models are real** (Gemini, Inkling), except in two places where a fake Gemini
  (`support/fake-gemini.ts`) stands in:
  - the "Gemini returns an empty answer" scenario, which the real Gemini cannot do on demand;
  - `abuse.feature`, so flooding the server costs nothing.

## Setup (once)

```bash
cp .env.example .env    # then fill in the keys
```

Each scenario names any setting it is missing when it fails.

## Running

```bash
npm test                    # everything
npm run test:abuse          # no keys needed (fake Gemini)
npm run test:inkling        # needs TINKER_API_KEY + Gemini keys
npm run test:cost           # real Gemini + prices in .env
npm run test:latency        # real Gemini
npm run test:downsampling   # real Gemini + Inkling + fixture images
npm run test:inkling -- --name "empty answer"   # one scenario by name
```

Every run writes `results/run-<time>.md`, with a pass/fail table and the measured numbers.
It is ready to paste into the PR. Server logs are in `results/logs/`.

## Downsampling fixtures

Put text images in `fixtures/text-images/`, each with a `.txt` of the same name holding its exact
text (for example `quran-page.jpg` and `quran-page.txt`). Use a mix of Arabic with diacritics,
English, screenshots and photos of full book pages.

## Status (2026-10-17)

| Feature | Result | Notes |
| --- | --- | --- |
| inkling-fallback | 5/5 pass | Passed after `207c827` (images reach Inkling); all 4 image scenarios failed before it |
| abuse | 6/9 pass | Unsized-body cap fixed in `207c827`; the 3 failures are proposed rules still to be agreed |
| cost | pass | Limits are first guesses; see the run reports |
| latency | pass | Upload time is computed from body size, not measured on a phone |
| downsampling | Gemini 1568 px only | The fixture images are under 1568 px, so they measure reading, not shrinking |

Still failing on purpose (proposals awaiting a decision):

| Scenario | Proposal |
| --- | --- |
| More than 20 image questions in an hour are refused | Per-user hourly limit, counted from stored image placeholders |
| More than 2 image questions at the same time are refused | Per-user concurrency limit |
| Guest accounts cannot attach images | Images for registered accounts only |

The limits in `abuse.feature` are proposals. Edit the feature file if we settle on different ones.

## Notes

- Cucumber 13 needs Node 22 or 24, not 23. `bin/cucumber.sh` uses `$BDD_NODE` if set, then Homebrew's
  `node@22`, then `node`.
- No Usul token yet? `ALLOW_MISSING_USUL=true` runs anyway. Usul searches then fail, so cost and latency
  come out lower than production, and every report says so at the top.
