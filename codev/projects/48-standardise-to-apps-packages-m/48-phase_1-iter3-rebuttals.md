# Phase 1 — Rebuttals, iteration 3

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues. |
| codex | REQUEST_CHANGES | 1 point — **accepted and fixed.** |
| claude | APPROVE | 2 non-blocking observations — one applied, one deferral endorsed. |

Nothing rejected.

---

## codex — setup docs `cd` into `apps/api` and never return to the root

**Accepted, fixed, and a genuinely good catch.** Both setup blocks entered `apps/api` and
then presented frontend commands from the wrong working directory:

- **`CONTRIBUTING.md`** then said `cd apps/frontend`. From inside `apps/api` that resolves
  to `apps/api/apps/frontend`, which does not exist — **fails loudly**.
- **`README.md`** was worse. It gave no `cd` at all, only a `# Frontend (from
  apps/frontend/)` comment. So a reader following it verbatim runs `pnpm start` while still
  inside `apps/api`, which executes **the api's** `start` script (`next start`) in the
  belief that they are starting Expo. **Fails silently, on the wrong app.**

Both shapes predate this change (previously `cd backend` → `cd frontend`, equally broken),
but Phase 1 owns the "a fresh clone can follow the docs verbatim" criterion, so they are in
scope here.

**Fix.** Each block is now explicitly root-relative, and the blocking dev server is called
out:

```
# Backend — from the repo root
cd apps/api
…
pnpm dev                # blocks: leave this running

# Frontend — in a SECOND terminal, from the repo root
cd apps/frontend
```

The second-terminal note is load-bearing independently of the directory bug: `pnpm dev`
blocks, so a single-terminal reading of these instructions was never runnable no matter
what the paths said.

**Verified by execution, not by reading.** Simulated the sequence from the repo root
(`cd apps/api` → OK, `cd apps/frontend` → OK) and confirmed the old chained form
(`cd apps/api && cd apps/frontend`) genuinely fails. Demonstrating both the bug and the fix
is worth more than asserting either.

**Left alone deliberately:** `CONTRIBUTING.md`'s Checks block uses location *comments*
(`# inside apps/api/`, `# inside apps/frontend/`) rather than chained `cd`s. That is
unambiguous and correct as written — no change needed.

---

## claude — APPROVE

Claude independently re-verified the phase rather than trusting the thread: suite, both
negative checks, both Docker images (including Caddy SPA placement *inside* the image),
lockfile purity, git history, railway globs asserted against the tree, and root-script
scope checked **at runtime**. It also confirmed the Phase-2/4 items are correctly *absent*
here — no `turbo.json`, frontend `dev`/`build` scripts still missing, `typecheck` still
`&&`-chained, frontend eslint still CJS — which is the right scope check for a phase whose
whole discipline is "paths and nothing else".

### 1. `RELEASE.md:30` names the Railway **service** `backend`
**Accepted — applied.** It is a dashboard entity name, not a repo path, so leaving it is
correct; claude's point is that a reader cannot tell that from the text and will read it as
missed drift. Added a parenthetical: *"(a name in the Railway dashboard — unrelated to the
`apps/api/` directory, and not stale)"*.

Cheap, and it pre-empts exactly the kind of well-meaning "fix" that would rename a live
external service to match a directory.

### 2. `eslint-env-guard.test.ts:55` test title still says `npm run lint`
**Deferral endorsed by the reviewer; unchanged.** Renaming it perturbs the test-*name*
baseline that this phase's central verification depends on, for cosmetic gain. Pre-existing,
not path-related, not operator-facing. Recorded rather than silently skipped, and a natural
pickup for later work that is not gated on a name-set diff.

---

## Verification at close of iteration 3

- Suite: **623 passed / 3 pending / 0 failed**.
- Test-name set vs `develop`: **exactly one line differs** — the intentional rename.
- Setup-doc sequencing proven runnable by execution; the old form proven broken.
- All earlier phase-1 evidence still holds (negative checks, both images, lockfile purity,
  `git log --follow`, railway globs, runtime script scope).
