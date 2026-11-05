// Issue #333: an event raised inside a request carries that request's headers
// (the user's JWT in Authorization, cookies) and, when an integration read it,
// its body. The negative control is sentry-request-data-control.test.ts.
//
// Assertions name which fixture leaked, never its value.
import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, expect, it } from "vitest";

import { SENTRY_REQUEST_PRIVACY } from "@/lib/sentry-scrub";

import { captureRequestEnvelopes, initSentry } from "./request-envelopes";

beforeAll(() => initSentry(SENTRY_REQUEST_PRIVACY));
afterAll(() => Sentry.close());

it("an event raised inside a request with a bearer carries no Authorization header, cookie, client IP, body, query or search terms", async () => {
  const { items, leaked } = await captureRequestEnvelopes();
  expect(items.map(([header]) => header.type).sort()).toEqual(["event", "event", "transaction"]);
  for (const [, event] of items) {
    expect(event.request?.method).toBe("GET");
    expect(event.request?.headers).toMatchObject({ host: "api.example.test" });
  }
  expect(leaked).toEqual([]);
});

// These pins exist to fail on an upgrade or an option change, not to document
// the defaults: Sentry v11 removes `sendDefaultPii` and collects by default,
// and under `traceLifecycle: 'stream'` spans skip beforeSendTransaction and
// need a streamed beforeSendSpan.
it("leaves Sentry's data collection and span lifecycle at what the scrub was written for", () => {
  expect(Sentry.getClient()?.getOptions().traceLifecycle ?? "static").toBe("static");
  const resolved = Sentry.getClient()?.getDataCollectionOptions();
  expect(resolved).toMatchObject({
    userInfo: false,
    httpBodies: [],
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
  });
});
