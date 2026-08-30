# Builder thread — pir-75 (Issue #75: port ansari-frontend@multisage, fix feedback 422, prod cutover)

## 2026-08-30 — Plan phase

Investigated both repos and drafted the plan (`codev/plans/75-port-ansari-frontend-multisage.md`).

Key findings that shaped it:
- The port is a **toolchain replacement**, not a src/ swap: source is Expo 52 / RN 0.76 /
  React 18 / NativeWind; the skeleton is Expo 57 / React 19 / uniwind. Faithful web-bundle
  parity requires the source's dependency set + babel/metro/tailwind config wholesale.
- Feedback 422 root cause verified end-to-end in both codebases: fabricated
  `Helpers.generateUniqueId()` ids in `addMessage` vs `z.string().uuid()` in
  `apps/api/.../feedback/route.ts`; `fetchThread` → `setActiveThread` is the existing
  reconciliation path (server GET returns real UUIDs).
- All 11 `EXPO_PUBLIC_*` vars the source reads are already ARGs in the migrated
  Dockerfile.web (`EXPO_PUBLIC_API_URL` in `src/env/index.ts` is dead code — module unused).
- Turbo needs no task changes for dropping uniwind's `gen:types`: undefined scripts no-op
  in dependsOn. `build:web` script must lose its `gen:types &&` chain.
- Identity merge table (migrated identity wins, source capabilities win) is spelled out in
  the plan; Expo-57-only `experiments` (reactCompiler/typedRoutes) must be dropped.
- Risks flagged: pnpm isolated linking vs Expo 52 (old repo used npm hoisting), catalog
  TS ~6.0.3 vs @types/react 18 (fallback: app-local pin, surfaced not silent).

Plan committed; sitting at plan-approval gate.

## 2026-08-30 — STOOD DOWN at plan-approval gate

Architect instruction (owner decision): the port's risk is too high for now. The feedback
422 bug is being fixed and deployed in the old repo instead
(`ansari-project/ansari-frontend` PR #76). No approval, no implementation. Worktree and
plan left intact — the plan (root-cause analysis, identity-merge table, env-var
enumeration, risk list) remains reference material if the port is revived. Awaiting
cleanup direction from the owner.
