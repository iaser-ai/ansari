# pir-94 thread — Promote the Expo prototype to apps/frontend

## 2026-09-01 — Plan phase

Investigated both trees. Findings that shaped the plan:

- Issue says "eas.json exists in both trees" — false: only `apps/frontend/eas.json` exists
  (f396356 legacy identity). Prototype has none. Reconciliation = keep scaffold eas.json
  verbatim + merge identity fields into the prototype's app.json.
- Prototype is SDK 54 / RN 0.81.5 / React 19.1.0, no uniwind/tailwind, reads exactly one env
  var (`EXPO_PUBLIC_API_URL`, staging default). Porting at SDK 54 — no upgrade.
- Whole `gen:types`/uniwind machinery (turbo.json task + edges, Dockerfile chain, package.json
  "//" note) becomes dead with the scaffold and is removed.
- f396356's expo-updates ~57.0.12 / expo-dev-client pins are SDK-57-tied; SDK-54 versions
  needed. Flagged in the plan per the issue's "don't break without flagging".
- PR #69 (+183/−11, 4 lib/api files): recommended re-apply onto apps/frontend post-merge as a
  fresh small PR, close #69 with a pointer. In the plan for the gate.
- Live `prototypes/ansari-expo` references exist only in historical codev records — plan
  scopes the acceptance grep to the live tree.

Plan written to `codev/plans/94-promote-the-expo-prototype-to-.md`, committed, at
plan-approval gate.

## 2026-09-01 — Stand-down

Owner declined project 94 at the plan-approval gate (relayed by architect): the interim
Nixpacks staging setup serving `prototypes/ansari-expo` is deemed fine as-is; the port is not
needed. No implementation was started. Plan preserved on branch `builder/pir-94` with a
stand-down banner (pir-75 precedent). Architect closes issue #94 and handles cleanup.

If this revives, note the plan's corrections to the issue text (no eas.json in the prototype;
SDK-54 pins for expo-updates/dev-client) and the PR #69 re-apply recommendation still stand.
