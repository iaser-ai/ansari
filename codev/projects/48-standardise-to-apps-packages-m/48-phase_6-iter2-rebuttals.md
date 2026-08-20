# Phase 6 — Rebuttals, iteration 2

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues. |
| codex | REQUEST_CHANGES | 2 points — **1 fixed, 1 PR-time by nature.** |
| claude | REQUEST_CHANGES | 2 points — **both fixed.** |

codex and claude independently found **the same defect**, which is worth noting: two
reviewers converging on one issue from different angles is strong evidence it is real.

## codex + claude — contradictory Railway guidance across four documents

**Accepted. My error, and a worse one than the mistake it came from.**

When I corrected the Railway guidance in iteration 1, I updated `RELEASE.md` and both
`railway.toml` headers — and left the old instruction standing in two other places:

- `docs/self-hosting.md`: *"set its config-as-code path to `apps/api/railway.toml`"*
- `codev/reviews/48-...md`: *"update the config file path"* — instructing an operator to
  change **a setting that does not exist**

So I turned one wrong document into **four documents disagreeing with each other**. That is
strictly worse than the original error: a single wrong instruction gets followed and fails
visibly; four contradictory ones get argued about, and whoever is deploying picks one at
random.

It is also the exact drift class this PR was written to eliminate — committed inside the
deliverable that documents the elimination.

**Root cause, plainly:** I fixed the places I happened to be editing instead of searching for
every instance. A documentation fix carries the same requirement as a code fix — find all the
sites, not the ones in front of you. I had already learned this lesson twice on this project
(`grant-admin.ts`'s runtime message vs its header comment; the literal `backend/` I
reintroduced into my own operator note) and still did not generalise it.

**Fixed all four, then verified by search rather than memory:**

| check | result |
|---|---|
| any live doc still instructing a config-file path? | none — the only hit is the review doc explicitly saying no such setting exists |
| all five files name the dashboard as authoritative? | yes (RELEASE.md, self-hosting.md, both tomls, review doc) |
| both operator-facing docs list `packages/**`? | yes |

`self-hosting-docs.test.ts` + `release-doc.test.ts` **14/14 green** after the rewrite — the
drift guards still hold against the edited sections, which is the point of having them.

## claude — review header stats had gone stale
**Accepted, fixed.** They predated iteration 1's fixes. Now regenerated from
`git diff --shortstat`: **79 commits · 280 files · +7492 / −193 · 17 review rounds.**

## codex — actual CI confirmation still pending
**Accepted; PR-time by nature, and correctly unmet.** Two acceptance items cannot be settled
before CI runs:

1. **gitleaks** — not installed locally. I verified `.gitleaks.toml` and `.gitleaksignore` are
   byte-identical to `develop` and the CI job is intact with `fetch-depth: 0`, but I have not
   run the scan and do not claim to have.
2. **`@ansari/types` lint/typecheck** — it has no consumer, so the app jobs' dependency-closure
   filters structurally cannot reach it; a dedicated step exists. Reading the workflow file is
   not evidence that a step *executed*.

Both are recorded as PR-gate checks. Marking them satisfied now would be exactly the
"reports success while not doing its job" failure this project has surfaced six times.

## Verification
Suite 66 files / 623 passed / 3 skipped · doc drift guards 14/14 · Railway guidance consistent
across all five documents, confirmed by search.
