import * as Sentry from "@sentry/nextjs";

import { SENTRY_REQUEST_PRIVACY } from "./lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: process.env.NODE_ENV !== "test" && !process.env.VITEST,
  environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  ...SENTRY_REQUEST_PRIVACY,
});
