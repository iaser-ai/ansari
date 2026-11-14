import * as Sentry from "@sentry/nextjs";

import { SENTRY_REQUEST_PRIVACY } from "./lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: process.env.NODE_ENV !== "test" && !process.env.VITEST,
  // The deployment label (#314 Amendment 3), the same vocabulary as apps/auth
  // (named after the legacy frontend's EXPO_PUBLIC_ENVIRONMENT; apps/frontend
  // has no such variable). Required everywhere, no default (owner, 2026-11-12);
  // validated at production boot (lib/boot-check.ts, right after this file).
  environment: process.env.ENVIRONMENT,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  ...SENTRY_REQUEST_PRIVACY,
});
