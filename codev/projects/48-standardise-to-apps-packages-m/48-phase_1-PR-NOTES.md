# Phase 1 — carve-outs and operator actions for the PR description

Collected here so they are not lost between phases. **Both must appear in the PR body**;
Phase 6's sweep criteria are worded absolutely and will otherwise re-litigate them.

## 1. `ansari-backend` is deliberately retained in the health response

`apps/api/src/app/api/health/route.ts` returns `service: 'ansari-backend'`. This is **not**
stale drift — it is a **public API response contract**, pinned by
`codev/specs/3-open-source-readiness-node-22-.md:144`:

> "`service` must remain `'ansari-backend'` (frontend and runbooks key on it)."

Renaming it would be a behaviour change, which spec 48 forbids. `RELEASE.md` and
`docs/self-hosting.md` document that same response body and are correct unchanged.

Phase 6's criterion reads "No tracked file refers to the package name `ansari-backend`" —
this is the stated exception to it.

## 2. CI check name is deliberately stale (deferred follow-up)

`develop` is protected (`protected: true`) and its required checks are exactly:

```
backend (lint, typecheck, test, build)
gitleaks (secret scan)
```

Required checks are matched **by name**. So the api job's **ID** was renamed to `api`
while its **emitted name** stays `backend (lint, typecheck, test, build)`. A job's ID and
emitted name are independent, so this costs nothing and avoids an unmergeable window.

**Do not "fix" the name.** Renaming it silently re-arms the blocker. It is a follow-up
requiring repo-admin access, done as one coordinated change: edit `develop`'s
required-check name **and** the `name:` line in `.github/workflows/ci.yml` together.

## 3. Open Dependabot PRs are not a defect

Ten are open, all emitting the `backend (...)` check. **Leave them.** Repointing
`dependabot.yml` obsoletes them and Dependabot re-opens against the new path. Do not close
them; do not report their staleness as a finding.

## 4. Post-merge checkpoint — Dependabot workspace coverage

`directory: "/"` covering every workspace package is only confirmable from GitHub's
Dependency graph after merge. A config that resolves nothing produces no error, just
silence. If coverage is missing, apply the per-directory fallback (`/`, `/apps/api`,
`/apps/frontend`, each `packages/*`).

## 5. Post-merge operator action — Railway

Each Railway service's "config file path" is a **dashboard** setting still pointing at the
old locations. Update to `apps/api/railway.toml` and `apps/frontend/railway.toml`, and
verify both services deploy. No PR can fix this.
