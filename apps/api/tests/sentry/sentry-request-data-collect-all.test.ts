// The scrub as the last line of defence (issue #333): with collection widened
// to collect-all, as Sentry v11 collects by default, the SDK keeps the client
// IP headers, cookies and bodies, and SENTRY_REQUEST_PRIVACY alone must keep
// every fixture out. Its own file: @sentry/nextjs honours only the first init
// in a process.
import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, expect, it } from "vitest";

import { SENTRY_REQUEST_PRIVACY } from "@/lib/sentry-scrub";

import { captureRequestEnvelopes, initSentry } from "./request-envelopes";

// Any dataCollection value switches every omitted category to collect-all.
beforeAll(() => initSentry({ ...SENTRY_REQUEST_PRIVACY, dataCollection: { userInfo: true } }));
afterAll(() => Sentry.close());

it("under collect-all settings, the scrub still keeps every fixture out", async () => {
  expect(Sentry.getClient()?.getDataCollectionOptions()).toMatchObject({ userInfo: true, cookies: true });
  const { leaked } = await captureRequestEnvelopes();
  expect(leaked).toEqual([]);
});
