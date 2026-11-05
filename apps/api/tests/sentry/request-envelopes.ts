// Shared driver for the issue #333 Sentry tests. Production-shaped: default
// integrations on, only the transport replaced, sampled as
// sentry.server.config.ts samples outside production. @sentry/nextjs honours
// only the first init in a process, so each file inits once, with its own
// options: the scrubbed run and its negative control live in separate files.
//
// Next reports every unhandled route error through `onRequestError`, which
// apps/api wires to Sentry.captureRequestError (src/instrumentation.ts); it
// attaches every request header. Events and transactions raised in a request
// scope carry the request data the scope holds, body and query included, and
// the root span's attributes: Next sets `http.target` to the request URL,
// query included (next/dist/server/base-server.js). @sentry/nextjs turns off
// Sentry's own incoming-request spans, so the root span here is a hand-made
// one carrying those attributes. A search tool's outgoing fetch puts the
// user's search terms in its query string, which an HTTP breadcrumb records.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import * as Sentry from "@sentry/nextjs";

import { onRequestError } from "@/instrumentation";

export const FIXTURES = {
  bearer: "USERJWTMARKER",
  cookie: "COOKIEVALUEMARKER",
  body: "USERMESSAGEMARKER",
  query: "USERQUESTIONMARKER",
  search: "SEARCHTERMMARKER",
  ip: "203.0.113.77",
};

const QUESTION_PATH = `/api/v2/mcp-complete?q=${FIXTURES.query}`;

const HEADERS = {
  host: "api.example.test",
  authorization: `Bearer ${FIXTURES.bearer}`,
  cookie: `probe=${FIXTURES.cookie}`,
  "x-real-ip": FIXTURES.ip,
  "x-forwarded-for": FIXTURES.ip,
  "content-type": "application/json",
};

type Item = [{ type: string }, { request?: Record<string, unknown> }];

const envelopes: unknown[] = [];

export function initSentry(options: Sentry.NodeOptions): void {
  Sentry.init({
    dsn: "https://public@o0.ingest.sentry.io/0",
    environment: "test",
    tracesSampleRate: 1.0,
    ...options,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
}

/**
 * Every envelope item an unhandled route error and an in-request event
 * produce, and which fixtures they hold (by name). The in-request event is
 * raised inside the root span after a search tool's outgoing fetch.
 */
export async function captureRequestEnvelopes() {
  envelopes.length = 0;
  const search = createServer((_req, res) => res.end("[]"));
  await new Promise<void>((r) => search.listen(0, "127.0.0.1", r));
  const searchUrl = `http://127.0.0.1:${(search.address() as AddressInfo).port}/search`;
  try {
    await onRequestError(
      new Error("probe: unhandled in a route"),
      { path: QUESTION_PATH, method: "GET", headers: HEADERS },
      { routerKind: "App Router", routePath: "/api/v2/mcp-complete", routeType: "route" }
    );
    await Sentry.withIsolationScope(async (scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          method: "GET",
          url: `https://api.example.test${QUESTION_PATH}`,
          query_string: `q=${FIXTURES.query}`,
          headers: HEADERS,
          data: JSON.stringify({ message: FIXTURES.body }),
        },
      });
      await Sentry.startSpan(
        {
          name: "GET /api/v2/mcp-complete",
          forceTransaction: true,
          attributes: {
            "http.target": QUESTION_PATH,
            "http.url": `https://api.example.test${QUESTION_PATH}`,
            "url.full": `https://api.example.test${QUESTION_PATH}`,
            "url.query": `q=${FIXTURES.query}`,
            "http.client_ip": FIXTURES.ip,
            "client.address": FIXTURES.ip,
            "http.request.body.data": JSON.stringify({ message: FIXTURES.body }),
          },
        },
        async () => {
          await (await fetch(`${searchUrl}?q=${FIXTURES.search}`)).text();
          Sentry.captureException(new Error("probe: raised inside a request"));
        }
      );
    });
    await Sentry.flush(2000);
  } finally {
    await new Promise((r) => search.close(r));
  }
  const items = envelopes
    .flatMap((e) => (e as [unknown, Item[]])[1])
    .filter(([header]) => header.type === "event" || header.type === "transaction");
  const text = JSON.stringify(envelopes);
  const leaked = Object.entries(FIXTURES)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);
  return { items, leaked };
}
