# Spec 48 — Rebuttals, Specify iteration 1

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues raised. |
| codex | REQUEST_CHANGES | 5 points — **all accepted and fixed.** |
| claude | REQUEST_CHANGES | 5 points (3 substantive + 2 smaller) — **all accepted and fixed**, 2 already fixed before the review landed. |

Nothing was rejected. Two claude items were already resolved by earlier commits, and one
of its points prompted me to **correct my own reasoning** rather than defend it.

---

## codex

### 1. Resolve the "Critical" open questions before planning
**Accepted — fixed.** Promoted all three from open questions to **decided defaults**, each
with reasoning plus an explicit "if overridden, here is what changes" note:

1. Shared config packages are deliberately thin; the `no-restricted-properties` env guard
   **stays in the backend**, because its allowlist (`lib/config.ts`, `drizzle.config.ts`)
   is expressed in backend-relative paths and is meaningless in a package shared with an
   Expo app.
2. `packages/types` ships as a real package with a placeholder export and no consumer —
   task scripts wired so the graph exercises it from day one.
3. Frontend `build` aliases `build:web`, so `pnpm build` genuinely covers both apps.
   Leaving `build` backend-only would reproduce the exact defect the issue exists to fix.

They stay visible as builder calls the architect can cheaply override at `spec-approval`,
rather than being silently absorbed into Constraints.

### 2. "61 test files" is wrong — it is 66
**Accepted — my error, fixed.** My `ls backend/tests/*.test.ts` glob was non-recursive and
silently missed `tests/api/`, `tests/lib/`, and `tests/migration/`. Verified: 66.

Went further than the correction, because a raw count is the wrong instrument — it cannot
distinguish a renamed test from one that stopped being collected. The criterion is now
**baseline-relative**: compare *test-name sets* against `develop`, with 66 quoted only for
orientation. (Claude independently flagged the same number.)

### 3. Specify the required CI task matrix
**Accepted — fixed.** The matrix is now pinned explicitly per package rather than
"exercises both apps". Writing it out surfaced something material: **frontend `build` in
CI is a genuinely new check** that does not run today. It is required if `pnpm build` is
to mean "both apps" rather than merely claim it.

### 4. Define behaviour-preservation criteria for shared config extraction
**Accepted — fixed.** "Whatever the apps genuinely share" was not a testable bar. Now:
- **ESLint** — the set of rule violations reported over each app's real source tree is
  identical before and after, captured with a machine-readable formatter and diffed.
- **TypeScript** — each app's fully-resolved options (`tsc --showConfig`) are unchanged,
  or every difference is individually enumerated and justified in the PR description.

### 5. Approach 2 contradicts the move-and-edit-separately mitigation
**Accepted — a real internal contradiction, fixed.** A move-only commit cannot be green:
every path consumer breaks. Resolved in favour of **move + path-fix as one indivisible
commit**, and corrected the premise behind the old advice — git records no rename, it
*infers* one at diff time from content similarity, so move+edit in a single commit
preserves blame fine for edits this small. The old mitigation was cargo-culted; it now
says so and points at `git log --follow` / `git show -M --stat` as the actual check.

---

## claude

### 1. The "not a shell `&&`" constraint collides with the frontend Docker build criterion
**Accepted — the most valuable finding in the round. Fixed.**

Verified the mechanism rather than taking it on trust: `apps/frontend/Dockerfile.web` runs
`pnpm install --frozen-lockfile --filter ansari-frontend` and then invokes `build:web`
**directly**. The root `package.json` has **no** `dependencies` and **no**
`devDependencies` today, so once `turbo` is added there, a `--filter`-scoped install will
not have it — nothing in that image can traverse the task graph. Deleting the `&&` from
`build:web` would leave `expo export` running with no `uniwind-types.d.ts`, breaking the
`docker build -f apps/frontend/Dockerfile.web .` acceptance criterion.

Resolution now stated in Constraints, turning on the constraint's **letter** — it names
**`typecheck`**, not `build:web`:
- `typecheck` drops its `&&` and gains a real `dependsOn: ["gen:types"]` edge → baked
  constraint satisfied as written.
- `build` gains the same edge, so graph-driven runs are correct.
- **`build:web` keeps its internal chain**, so the container path works without Turbo.
- The redundancy is documented as **deliberate and belt-and-braces** — `gen:types` is
  idempotent codegen and the Turbo path makes the second call a cache hit — specifically
  so a later reader does not "tidy it up" and silently re-break the image.
- Also flagged: CI's frontend typecheck step carries a comment explicitly relying on the
  `&&`; it must be updated rather than silently invalidated.

### 2. "61 test files" should be 66
**Accepted — already fixed** before this review landed (see codex #2). Claude reviewed a
pre-fix snapshot. Its diagnosis of *why* the undercount matters — a criterion meant to
catch silent test loss encoding a number below reality — is exactly right and is why the
criterion is now baseline-relative rather than merely corrected.

### 3. `test:coverage` is unmodelled
**Accepted — fixed.** CI runs `test:coverage`, not `test`. I had listed it in the CI matrix
but never modelled it as a Turbo task, leaving "CI runs through Turborepo" unsatisfiable as
written. `turbo.json` must now model `test:coverage` with `outputs: ["coverage/**"]`.

### 4. The Docker `workspace:` mitigation is incomplete
**Accepted — fixed.** Copying `packages/*/package.json` is necessary but **not sufficient**:
if an app's `tsconfig.json` extends a shared base, `next build` needs the package
*contents*, so `COPY packages packages` is required too. The half-fix produces an install
that succeeds and a build that fails later — the worst shape — and the risk row now says so.

### 5a. `.github/PULL_REQUEST_TEMPLATE.md` is an unenumerated path consumer
**Accepted — verified and fixed.** Lines 16 and 26 instruct contributors to run checks
"from `backend/`" with "`backend/.env.ci`". Added to Current State and to the docs
acceptance criterion. This is the **second** consumer my own inventory missed after the
frontend trio, which is evidence the "no stale path survives" scan is doing real work as a
backstop rather than being a formality.

### 5b. `gen:types` must declare `uniwind-types.d.ts` as an output
**Accepted — fixed, and it is subtler than it looks.** The file is **gitignored**, so on a
warm cache Turbo skips re-running `gen:types` — and if it is not a declared output there is
nothing to restore, leaving it absent and the dependent task broken. The failure is green
cold and broken warm, which is precisely the shape that survives a review. Added as its own
success criterion, verified by deleting the file with the cache warm and confirming Turbo
restores it.

### 6. Minor — `release-doc.test.ts` fails loudly, not silently
**Accepted as a correction to my own reasoning.** I had framed both doc-consistency tests
as at risk of *silently passing while asserting nothing*. Checked: both `readFileSync`
their target doc at module load, so a stale `'..'` resolves to `apps/RELEASE.md` /
`apps/docs/self-hosting.md`, throws `ENOENT`, and takes the suite down loudly.

The realistic failure mode is therefore **not** "passes while asserting nothing" — it is a
builder seeing the loud failure and patching the path just far enough to go green without
confirming it now points at the true repo root. Rewrote the Test Scenarios calibration to
say that, and kept the negative check as belt-and-braces against that behaviour and against
the same class of upward-resolving assertion elsewhere, rather than as the sole net.

Over-claiming a risk misdirects review attention as surely as under-claiming it, so this
was worth correcting rather than leaving as harmless over-caution.

### Structure
Claude independently confirmed the spec matches the **delivered** SPIR template from
`@cluesmith/codev` v3.3.1, and that the longer 21-heading shape in `codev/specs/4-*.md` is
a superseded template rather than a miss. No action needed.

---

## Changes not prompted by review

Recorded here so the diff is fully accounted for:

- **`apps/backend` → `apps/api`, `ansari-backend` → `ansari-api`** (human decision;
  architect confirmed and is updating issue #48's target layout to match). Driven by a
  planned `apps/auth` extraction: "backend" is a *tier* name, "auth" is a *domain* name,
  and once both exist `apps/backend` is ambiguous because auth is backend code too.
  Frontend unchanged. Scope-fenced: the rename is **strictly a rename**; extracting
  `apps/auth` is explicitly out of scope here.
- **Shared packages named `@ansari/*`** while the apps stay flat and unscoped.
- **`.github/dependabot.yml` fixed properly rather than repointed** (architect scope
  addition). It is already stale independent of this PR. Noted for the plan that
  Dependabot has **no `pnpm` value** for `package-ecosystem` — pnpm is handled by the
  `npm` ecosystem — so the ecosystem key stays as-is and the fix is in the directories,
  the comment, and the coverage.
- **Both `railway.toml` promoted into Success Criteria** (architect scope addition), with
  the assertion sharpened: a `watchPatterns` glob that matches nothing **fails silently**
  — it does not error, it just stops triggering deploys — so the globs must be asserted
  against the real tree rather than eyeballed.
