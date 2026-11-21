# task-a985 thread (#416: legacy web maintenance flag replaces the production web detach)

- 2026-11-21 10:30 Brief from security: production window takes legacy web offline with PR #418's build-time
  MAINTENANCE_MODE on the legacy web service instead of detaching the web domain. Docs only.
- 418 was already merged to main (b1b6ddf0). Merge-back #420 landed on develop at ac4dca53; this branch
  fast-forwarded to it before any edit was committed. Cited lines were re-verified on that tree (Dockerfile:7,18
  became 7,21; getEnv.ts:2 became :11).
- Contradiction raised and accepted by security: the brief asked to say "the detach did not have the open-tab
  residual". It did: legacy web calls the absolute, cross-origin EXPO_PUBLIC_API_V2_URL (ApiService.ts:35;
  ACAO * at next.config.ts:24). The detach stops new loads, not an open tab. Written as "same residual under
  both"; step 1 gains an owner check that the production value is an absolute api origin.
- Measured: a local expo export of main's legacy/frontend-web with the flag on showed the maintenance screen on
  /, /login, /reset-password, /share/<id> and /chat/<id> with zero api requests. The served bundle carries
  `MAINTENANCE_MODE:()=>E("true")` (on), `E(void 0)` (unset, local) or `E("")` (Docker, no arg). That became
  step 3's bundle check.
- 12a: I proved a local Docker build of legacy web reaches the staging api from localhost (login 401 rendered).
  Then OWNER DECISION (10:39): 12a skipped in production, local-build work dropped. 12a now says "not available
  with the flag"; legacy web on the new api is first exercised at steps 13/14 with real users (owner-accepted).
  The staging 12a text is kept as it was. The local image was deleted.
- Staging keeps the detach everywhere (apps/frontend has no switch, #419). Step numbers unchanged; step 13 and
  rollback step 4 retitled "Web back".
