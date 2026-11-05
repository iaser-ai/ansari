# Ansari MCP

A standalone MCP application. `answer_islamic_question` calls the Ansari API and returns its complete answer and attribution unchanged. SAGA links each result to one content-addressed, self-contained React card. The application owns Ansari branding, floral artwork, theme mapping and Hono HTTP hosting; SAGA owns content interpretation, FaithfulCard rendering, content policy, consent and MCP view linkage.

## How it works

[Explore the interactive walkthrough](docs/show-me-ansari-mcp.html) for the complete question-to-card flow, UI states, code ownership, build process and why it builds on SAGA. Download the self-contained HTML and open it in a browser; GitHub displays its source. The walkthrough uses synthetic content and makes no live requests.

## Screenshots

English and Arabic answer cards rendered in ChatGPT desktop web through the Dev connection on October 23, 2026. Both rendered on first load with application revision `ee7ea4a78933544c4a96577d7ffd7276df8ae037` and public npm SAGA SDK `0.7.6-rc.1`. Arabic headings, paragraphs and lists use RTL layout and the embedded Kitab fonts. The application owner also supplied the ChatGPT and Claude mobile captures below. These captures retain their original revision identity. The application owner accepts the existing ChatGPT, Claude and earlier Alexa baseline; the [consolidated host and release evidence](https://github.com/MachineWisdomAI/saga-a2ui/pull/321) records each observation and its limits. Earlier Alexa evidence is not presented as a fresh stable-version run, and the 239 successful RC HTTP requests measure transport activity rather than rendered answers.

### English

![English answer card in ChatGPT Dev, showing the complete answer, floral branding, attribution and SAGA credit](docs/screenshots/chatgpt-dev-english.jpg)

### Arabic

![Arabic answer card in ChatGPT Dev, showing RTL text, numbered floral markers and attribution](docs/screenshots/chatgpt-dev-arabic.jpg)

### ChatGPT mobile

User-provided capture of the Dev answer card in ChatGPT, showing English text and floral branding.

![Ansari MCP Dev card in ChatGPT mobile](docs/screenshots/chatgpt-dev-mobile.jpg)

### Claude mobile

User-provided capture of the Dev answer card in Claude, showing Arabic text, RTL layout and numbered floral markers.

![Ansari MCP Dev card in Claude mobile with Arabic RTL content](docs/screenshots/claude-dev-mobile.jpg)

## Dependencies

SAGA is installed from the public npm registry at one exact release, `0.7.6` (stable), from the [0.7.6 release branch](https://github.com/MachineWisdomAI/saga-a2ui/tree/codex/release-0.7.6): the stack `@saga-a2ui/react-mcp-stack`
plus its exact-version siblings `@saga-a2ui/core`, `@saga-a2ui/components`, `@saga-a2ui/mcp` and `@saga-a2ui/react`. No private registry,
credential, SDK tarball, SDK workspace link or SDK-package override is involved, and the manifest pins an exact version rather than a tag or range.
`pnpm check:release --target beta` checks the pinned release against the registry and the lockfile; `--target production` additionally refuses a
prerelease. The Beta and Production deploy scripts run the corresponding gate before any build or deployment.

The application depends on one SAGA package, the stack `@saga-a2ui/react-mcp-stack`, plus React and React DOM, and imports
only its subpaths: `/faithful-card` (`FaithfulCardApp`, `startFaithfulCardApp`, and the definition's one `.result(...)` reader that reads the whole delivered result,
`useHostLink`, `readingProfile`) and its stylesheet in the view; `/content-policy` (`createContentPolicy`, `embedContentPolicy`)
in the build; `/server` (`registerPublicOperation`, `operationViewFromHtml`, `createServerBudgets`, `attachRequestLifetime`) in the
MCP server. The browser bundle holds no `/server` module. The stack's exact-version siblings come from the same release,
and its installed tree includes `@saga-a2ui/components` and `markdown-it`. SAGA owns its A2UI and Zod 3 dependency
context; the application uses Zod 4 for MCP. Do not add direct `@a2ui/react` or `@a2ui/web_core` dependencies or cast between their
schema types. The artwork owner has authorized contribution and redistribution with the application; see `assets/NOTICE.md`.

## Development

Requires Node 22.18 or later and pnpm 10.33. Install once from the repository root using its authoritative lockfile. Run the app explicitly; root build, test, typecheck and coverage retain their existing scope, while root lint includes this application.

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies --filter ansari-mcp...
pnpm mcp build
pnpm mcp typecheck
pnpm mcp lint
pnpm mcp test
pnpm mcp exec playwright install chromium
pnpm mcp test:browser
pnpm mcp start
```

`build` writes `dist/view.html` and a bundled `dist/server/index.js`. No API/auth/frontend build or SDK source checkout is needed. `dev` runs the Node entry source (`src/node/index.ts`) after `build`. The synthetic browser harness is test-only and uses no credentials or live answers.

`test` runs `build` and `build:worker` itself before any test, because the tests run the built artifacts: without a fresh build they pass against a stale `dist/`. `test:browser` reads `dist/view.html` without building, so run it after `test` (as `verify` and the Turbo task order do).

### Two hosting targets, one application

The same Hono application and official MCP handler (`src/server/fetch-app.ts`) run on Node/Docker and on Cloudflare Workers. Each target is a thin entry that supplies configuration, logging and the built card explicitly: `src/node/` (`index.ts` and `http-server.ts`: environment, filesystem read at start, listener, signals) and `src/worker/index.ts` (Worker bindings, console, the card bundled at build time). Both adapters import the shared code in `src/server/`; shared modules import neither adapter and read no file, environment or process object.

| Target | Build | Run locally | Check |
| --- | --- | --- | --- |
| Node/Docker | `pnpm build` writes `dist/` | `pnpm start` (or the Docker commands below) | `pnpm test` |
| Workers | `pnpm build:worker` writes the bundle to `dist-worker/` (Wrangler `deploy --dry-run`; nothing is published) | `pnpm dev:worker:dev` (Wrangler's local runtime, workerd; an environment is always named: `dev:worker:<env>`) | `pnpm test` |

```sh
# Clean frozen installation, then both artifacts and every check (Node, Workers and browser):
pnpm install --frozen-lockfile --strict-peer-dependencies --filter ansari-mcp...
pnpm mcp verify          # lint, typecheck, test (which builds both targets first), test:browser

# Run the Worker in Wrangler's local runtime under one declared environment (dev, beta or production). Its local secrets are `.dev.vars.<env>` only (git-ignored, and excluded from the Docker build context, together with `.wrangler/` and `dist-worker/`). The script refuses a generic `.dev.vars`, which Wrangler would read for every environment, and turns off Wrangler's `.env` fallback.
pnpm dev:worker:dev --var ANSARI_RELEASE:local-1
curl http://127.0.0.1:8787/health
```

The Worker takes the variables in the table below as Wrangler `vars` or secrets, not from `process.env`; `PORT` does not apply. `wrangler.jsonc` shares only the compatibility settings (`nodejs_compat`: the MCP SDK uses Node's crypto and buffer modules) and declares three named environments, `dev`, `beta` and `production`, each with its own Worker name, hostname, client label and allowlist; there is no top-level Worker, so a bare `wrangler deploy` publishes nothing. Secrets are never declared there. The `beta` and `production` hostnames are `replace-with-*` placeholders that the deploying owner must replace; do not deploy those environments while one remains. `test/parity-node.test.ts` and `test/parity-workers.test.ts` run one set of HTTP/MCP cases against the built Node server and the built Worker bundle in the local Workers runtime, each with a real synthetic upstream. They show local behaviour only; they are not a deployment, Cloudflare limit or host acceptance check. Node's signal shutdown stays in `test/lifecycle.test.ts`; the Worker's cleanup check is a caller disconnecting mid-call and the runtime stopping without leftover processes.

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP port (default 3000). |
| `ANSARI_API_BASE_URL` | Ansari API origin (default `https://api.askansari.ai`). |
| `ANSARI_API_AUTHORIZATION` | Optional upstream Authorization header. Supply through the environment; never commit it. |
| `ANSARI_CLIENT` | Upstream client label (default `ansari-mcp`). |
| `MCP_ALLOWED_HOSTS` | Comma-separated allowed HTTP Host names, without scheme. A configured list replaces local defaults; an explicitly empty list permits no Host. Only an absent variable defaults to localhost and 127.0.0.1. |
| `MCP_ALLOWED_ORIGINS` | Comma-separated allowed browser origin hostnames. A configured list replaces defaults; an explicitly empty list permits no Origin header value. Requests without Origin remain supported. |
| `MCP_RESPONSE_MODE` | `json` for modern MCP final-answer-only responses; otherwise SSE, which supports client-requested progress notifications. Older-host compatibility responses may use SSE. |
| `ANSARI_RELEASE` | Optional safe release identifier, embedded in served HTML and health/log records. |
| `MCP_VIEW_DIAGNOSTICS_ORIGIN` | Set only on a deployment being diagnosed: its own public origin, such as `https://ansari-mcp-development.up.railway.app`. The card may then connect to that one origin and reports its start-up milestones to `POST /diag/view`; this changes the card's bytes, address and permissions. Unset, the card, its address and its closed permissions are unchanged and the route does not exist. A value that is not a bare `https` origin (`http` only for localhost) stops startup. Implies `MCP_LOG_LEVEL=debug`. See [First-load diagnosis](#first-load-diagnosis). |
| `MCP_LOG_LEVEL` | `info` (default) or `debug`. `debug` also writes the first-load measurement records; set it only on a deployment being measured. Any other value, or `info` together with `MCP_VIEW_DIAGNOSTICS_ORIGIN`, stops startup. |

`POST /mcp` serves stateless MCP requests through Hono and the official MCP request handler. Modern requests need no initialization; older hosts can use the handler’s stateless compatibility path. No MCP session IDs, session map, expiry timer or replay store are retained. `GET /mcp` and `DELETE /mcp` return 405. `/health` exposes the release. The HTML is supplied by the hosting target (read from `dist/` at Node start, bundled into the Worker), revision-stamped and fingerprinted once before the first request is served: the release is stamped first, so equal final bytes have equal identities and a release change legitimately changes the hash. Each request creates its own lightweight MCP server using that prepared view; resource bytes and identity stay fixed until restart. No demo, font server, alternative renderer or historical resource is served. Tool calls have a fresh 60-second budget; timeout yields a safe error and leaves subsequent calls usable. The same lifetime signal aborts the upstream fetch and response-body read when the request ends or the budget expires.

Closing a request server releases its budget even if it was never connected to a transport. On SIGINT or SIGTERM the listener stops accepting requests, closes MCP handlers and HTTP connections, and exits; unfinished calls are interrupted, including older-host SSE calls. Fetch cancellation does not guarantee that the remote backend has stopped processing. Caller-disconnect propagation depends on the host transport; the local Workers runtime does not establish immediate upstream cancellation from a client disconnect. Actual fetch cancellation at the request deadline is covered on both hosting targets.

## First-load diagnosis

A bounded experiment for issue #335, not a permanent observability design. In Claude web and ChatGPT web the host's
own error replaced the card on first load and one Retry recovered it; the card's own failure texts never appeared, so
the host gave up before the card showed anything. The aim is to locate the first missing step between the card read,
the card's start, the host handshake, tool-result arrival and the first rendered answer, where that step can be
observed at all. After the trials, this is removed or narrowed to what proved useful.

**Log levels.** Every record carries a `level`. `error`: `mcp.error` and `source.error`, by error name and code only.
`warn`: rejected or rate-limited card reports. `info`: the operational records (`startup`, `mcp.request` with the HTTP
method, `source.start`, `source.complete`). `debug`: the measurement records below, written only with
`MCP_LOG_LEVEL=debug`. At `info` the server neither inspects nor wraps an exchange, and it writes the records of a
deployment without this experiment, plus a level on each and error
names and codes; dropping the `debug` lines from a measured deployment leaves the same records.

**Server records, while measuring.** Each `/mcp` exchange also writes `mcp.rpc` and `mcp.response` lines joined by
`rid`. The request is inspected from a copy, alongside the handler and up to 64 KiB actually read, so inspection never holds up
or alters the exchange; a larger body is recorded as `oversize`. The request line names the JSON-RPC method; for a card
read, the address read and whether it is the one this instance serves (`uriCurrent`); for the handshake, the client's
name, version and protocol; for a tool call, the tool name. The response line has the HTTP status, bytes, time to
headers and total time, and `stream`: whether this side's response stream was `drained`, `cancelled` or `failed`. That
is not proof the host received or rendered it. Responses up to 64 KiB are decoded as JSON-RPC for an error code; a
stale card read is `-32602` inside an HTTP 200. At start, `view.prepared` records the served card's address, size,
whether it is a diagnostic card and its connect origins. Handler errors are logged by name and code. These records hold
no question, answer or other parameter value. A closed-card trial still needs these records: set
`MCP_LOG_LEVEL=debug` and leave `MCP_VIEW_DIAGNOSTICS_ORIGIN` unset.

**Card reports, diagnostic card only.** With `MCP_VIEW_DIAGNOSTICS_ORIGIN` set, the served card carries an
`ansari-diagnostics` address in its head, may connect to that one origin, and changes bytes, address and permissions.
Compare its trials with the closed card's rather than assuming they behave the same. An early script, which runs
before the bundle is parsed, records errors, unhandled rejections, content-policy violations and when the host's
messages arrive (first message, tool input, tool result, cancellation, teardown request), by method name only. The
stack's hooks add font loading, host-context delivery, how starting ended and the first rendered answer or problem. The
early script reports by itself at `load`, at `pagehide` and after 15 s without a start, so a bundle that never runs is
still reported; the bundle adds reports when the card is ready, fails, or renders its first answer or problem. Each
report is an `[ansari-view]` console line and a beacon to `POST /diag/view`. The route accepts only the fixed report
shape, at most 8 KiB and 120 reports a minute per instance, and logs `view.report` (level `debug`) with `clientAuthored: true`: the
shape limits what is logged, but anyone who can reach the route can send a report. Report fields are milestones,
enumerated failures and error names; the stack still prints a callback's own error to the console, as before. One
violation is expected on every load: zod's `new Function('')` capability probe under the card's `script-src`, which it
catches. The closed card's early script does nothing.

**Trials.** Use the deployment for nothing else while a trial runs. Run one trial per new conversation, with the
deployment live for hours (`aged`) and right after a redeploy (`fresh`), and with the diagnostic and the closed card.
The trial script records the deployment's release and the first attempt and Retry as separate windows:

```sh
bash scripts/first-load-trial.sh https://ansari-mcp-development.up.railway.app claude aged diagnostic
# Railway: deployment and edge HTTP logs covering the trials, then one timeline per trial.
railway logs --deployment --json --since 1h > test-results/first-load/app.jsonl
railway logs --http --json --since 1h > test-results/first-load/edge.jsonl
node scripts/first-load-timeline.mjs test-results/first-load/trials.jsonl test-results/first-load/app.jsonl test-results/first-load/edge.jsonl
```

Records are attributed to an attempt by time only; neither `rid` nor a card's id links to the host's attempt. The
timeline lists what was observed in each window and flags windows with more than one MCP client, overlapping trials or
another release as ambiguous. A finding such as "no host message observed by its last report" says only that. Two
controlled cases have known answers: a stale card read (`resources/read` of an earlier address, answered `-32602`) and
a bundle that fails before it runs (covered by the browser checks: a `load` report without `main` and with the
`SyntaxError`).

## Workspace and container

This package lives at `apps/mcp` and is named `ansari-mcp`. The root `pnpm-lock.yaml` and `pnpm-workspace.yaml` are the only install inputs. `pnpm mcp <script>` targets this app. Shared TypeScript and lint tools use the workspace catalog; no application-local lockfile or standalone workspace is maintained.

The pnpm override pins `@a2ui/markdown-it` to `0.2.1`: A2UI React 0.13 permits adapter 0.2.2, but that adapter requires
incompatible web_core 0.14. The root workspace scopes this compatibility pin to `@a2ui/react@0.13.0>@a2ui/markdown-it`. Keep it until SAGA's supported dependency combination changes. SAGA's own Markdown parser
remains its private dependency. Do not add direct A2UI dependencies to this application.

The Docker build context is the repository root, including its lockfile and the shared configuration packages:

```sh
docker build -f apps/mcp/Dockerfile -t ansari-mcp .
docker run --rm -p 3000:3000 --env-file apps/mcp/.env ansari-mcp
```

The built card document names the SDK it was built from beside the application release: `<meta name="ansari-sdk">` and
`data-sdk-kind`, `data-sdk-version`, `data-sdk-source`, `data-sdk-stack-sha256` and `data-sdk-set-sha256` on `<body>`, next to
`data-release` (the application version) and, once served, `data-revision` (the deployed commit). They are read by `node scripts/sdk-identity.mjs`:
`data-sdk-kind` is `registry` and `data-sdk-version` is the pinned stack version; the registry integrity of every SAGA package is in the lockfile, so the
source and digest fields read `none`. An older cached card shows a different version.

The runtime contains only the compiled server and self-contained HTML. The HTML retains complete applicable SAGA Apache-2.0, third-party, application MIT, artwork and font notices in an inert comment. The build installs everything from the public registry with the committed lockfile; it needs no private registry credentials.

## Assets

Artwork is embedded as actual SVG/PNG data in application-local TypeScript modules. Kitab Regular and Bold are bundled into the HTML and loaded through binary `FontFace` sources. Some hosts block `data:` font URLs through their outer CSP; using the embedded bytes directly needs no font request or host policy change. Both weights must load before an answer appears, and teardown removes the owned font faces. No device font or font server is required. See `assets/NOTICE.md`. SDK licensing does not grant rights to Ansari artwork.

## Continuous verification

The `MCP application` workflow runs for app, lockfile, workspace, root manifest/ignore, workflow and shared lint configuration changes on PRs and develop/main pushes. It installs the root lockfile frozen, then runs app lint, typechecking, both builds, tests and browser checks. `bash apps/mcp/scripts/verify-container.sh` performs one uncached root-context Docker build and verifies health, synthetic tool calls, full attribution, safe failure/recovery and resource identity in a container with no external network or mounted files. It removes its container and image on exit. Node 22, pnpm 10.33, Docker and Chromium system dependencies are required.

This job needs no host credentials. Deployment and actual
ChatGPT, Claude and Alexa rendering remain separate integration checks.

The footer framework credit is controlled by `BRANDING.showSagaCredit` in
`src/view/branding.ts`. Set it to `false` to remove the credit. Its link uses
the same content policy as answer links; Strict displays an inert text credit.

Hono runs on Node through `@hono/node-server`; the official `@modelcontextprotocol/hono` middleware validates Host and Origin.

## MCP compatibility

The tool retains the legacy server's `answer_islamic_question` name, detailed description and input help, and `readOnlyHint: true` / `openWorldHint: true` annotations. It accepts 1–4,000 characters, matching the Ansari API. The earlier experimental RC exposed `ask_ansari`; a deployment owner must refresh host discovery when adopting this tool name. The endpoint remains `/mcp`. Replacing the existing `mcp.ansari.chat` service and changing its DNS are separate rollout actions.
