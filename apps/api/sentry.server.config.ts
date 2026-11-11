import * as Sentry from "@sentry/nextjs";

import { SENTRY_REQUEST_PRIVACY } from "./lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: process.env.NODE_ENV !== "test" && !process.env.VITEST,
  // The deployment label (#314 Amendment 3), the same vocabulary as apps/auth
  // and the frontend. Validated at production boot (lib/boot-check.ts, which
  // runs right after this file); unset only outside production.
  environment: process.env.ENVIRONMENT || "development",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  ...SENTRY_REQUEST_PRIVACY,
});
