# bugfix-333 thread

## Investigate (2026-10-28)
- Reproduced on develop with spir-329's test (spy transport, default integrations, 40 failed sign-ins): 1 event; `request` keys = headers, method, url, cookies, query_string, data; `headers.authorization` present; password marker in envelope.
- Root cause: apps/auth `initSentry` sets only `sendDefaultPii: false`, no `beforeSend`; apps/api `beforeSend` drops only `request.data`.
- #331 (builder/spir-329) still open; it adds `SERVICE_SENTRY_OPTIONS` with an exchange-only `scrubExchangeEvent`. Plan: add a general scrub here under the same `SERVICE_SENTRY_OPTIONS` name so either rebase is a one-line merge.

## Fix (2026-10-28)
- apps/auth: `scrubRequestEvent` reduces every event's `request` to `{method, url without query}`; `SERVICE_SENTRY_OPTIONS` = sendDefaultPii false + breadcrumbs off + that `beforeSend`. Same shape as #331's options; the general scrub subsumes `scrubExchangeEvent`.
- Surprise 1: with only the beforeSend scrub, the query string still reached Sentry through HTTP breadcrumbs (`breadcrumbs[].data.http.query`). Breadcrumbs off (as #331 does) closes it.
- apps/api: under `@sentry/nextjs` a plain node http server attaches no request data; the production paths are `onRequestError` (captureRequestError: all headers) and request-scope events/transactions. Test drives the real `onRequestError` export.
- Surprise 2: `@sentry/nextjs` honours only the first `Sentry.init` per process (re-init after close keeps the closed client), so the apps/api negative control is its own file.
- Surprise 3: Next's root-span hook copies cookies into transaction span attributes (`contexts.trace.data.http.request.header.cookie.<name>`), filtering only sensitive-looking names. Fixed with `dataCollection: { cookies: false }` + `beforeSendTransaction`.
- Mutations (apps/api): no dataCollection / no beforeSendTransaction / keep authorization / keep data → red. Keep cookie header → green (equivalent while cookies collection is off; strip kept as defence in depth).
- `afx send` failed: Tower not running.

## PR #334 review iteration 1 (2026-10-28)
- Codex and Claude (REQUEST_CHANGES, both HIGH): `dataCollection: { cookies: false }` flipped Sentry's resolved data collection to collect-all for every omitted category. Verified: userInfo true, all httpBodies, genAI inputs/outputs true (user prompts and Gemini answers), databaseQueryData true. Real regression, caught before merge.
- Fix: option removed; `scrubRequestEvent` now drops credential span attributes (`http.request.header.{authorization,cookie}*`, `http.response.header.set_cookie*`) from `contexts.trace.data` and `spans[].data`. New test pins resolved collection at the private defaults.
- Mutations (apps/api), all red: no span-attribute strip, no beforeSendTransaction, keep authorization, keep data, keep cookie header, partial dataCollection reintroduced.
- Gemini lane skipped (agy exit 3). Commit prefix kept as `[Bugfix 333]` per the architect's brief (codex asked for `[Bugfix #333]`/`Fix #333:`).
- Not done: `beforeSendTransaction` in apps/auth (no tracing there; would diverge from #331's options).
- Lesson: in @sentry/core 10.x, ANY `dataCollection` value opts in to collect-all defaults for omitted keys. Never set it partially.

## PR #334 review iteration 2 (2026-10-28)
- Codex REQUEST_CHANGES on commit prefix only (no code/test issues). Kept `[Bugfix 333]` per the architect's brief; flagged for the architect.
- Claude COMMENT: apps/api kept the query string; `/v2/mcp-complete?q=` is the user's question (verified, route.ts:274). Fixed: scrub drops `query_string` and the URL's query; query fixture added (control leaks it; M7/M8 mutants red).
- Residuals Claude raised, left for a follow-up issue: apps/api breadcrumbs still on (outbound search URLs carry user terms); apps/auth keeps the URL path (better-auth `reset-password/:token`); `sentry.client.config.ts` has no scrub.
- Sentry v11 (latest 11.10.0; we run 10.69.0) removes `sendDefaultPii` and defaults `dataCollection` to collect-all (cookies, headers, bodies, DB query data) per its MIGRATION.md. The scrubs hold either way; settings pins in both apps make an upgrade fail loudly.

## Architect asks before the gate (2026-10-29)
- Commit prefix: the brief's `[Bugfix 333]` was wrong; develop uses `[Bugfix #333]` (cf. #330). Rewriting the three commits and force-pushing with --force-with-lease (architect-approved).
- Client IP: architect asked to drop `x-real-ip` and `x-forwarded-for` in apps/api. Finding: on @sentry/core 10.69 the SDK already deletes every `ipHeaderNames` header from `event.request` while `userInfo` is off (`requestdata.js` `extractNormalizedRequestData`), so the negative control shows no IP leak. The drop matters once `userInfo` is on (v11's default). New `sentry-request-data-collect-all.test.ts` runs the privacy options under collect-all settings. It caught two more IP routes: span attributes `http.request.header.{x_real_ip,x_forwarded_for}` and `user.ip_address`. All now scrubbed; mutants M9–M12 red.
- Residuals stay for the owner's follow-up issue (not this PR).

## Integration review S1–S7 (2026-10-29)
- S1 (blocking, confirmed): apps/api span attributes carried the URL with its query. Under @sentry/nextjs, Sentry's incoming-request spans are off (`disableIncomingRequestSpans`), but Next's own root span sets `http.target: req.url` (next/dist/server/base-server.js:480). Scrub now drops url.full, url.query, http.url, http.target, http.query, http.request.body.data, http.client_ip, client.address, and strips the query from `contexts.nextjs.request_path` (captureRequestError records it; found by the extended test, not in the review). The x-real-ip/x-forwarded-for header drops stay: redundant on 10.69 (SDK drops them while userInfo is off) but load-bearing under collect-all, proven by the collect-all test.
- S2 (blocking): apps/api breadcrumbs off. The test now drives a real outgoing fetch with the search term in `?q=`; with breadcrumbs on it leaks via `breadcrumbs[].data.http.query`, and the fetch's child span also carried `http.query` (now dropped).
- S3: `beforeSendSpan: scrubSpan` (static lifecycle) + pin on `traceLifecycle` beside the data-collection pin. M16 (no beforeSendSpan) is equivalent under 'static' because beforeSendTransaction scrubs spans[].
- S4: driver's root span now carries Next-shaped attributes, onRequestError gets a path with a query, and items are filtered to event/transaction (CI at d94f9b78 failed on an extra `session` item in my exact-type assertion; not a leak).
- S5: apps/auth control with breadcrumbs on and a fixture log line written in the request (wrapper around the failed-sign-in alert, console.warn silenced before init so nothing prints). M17 red.
- S6: apps/auth keeps host, user-agent, content-type. M18/M19 (authorization/cookie allowed) red.
- S7: composition steps written into the PR body.
