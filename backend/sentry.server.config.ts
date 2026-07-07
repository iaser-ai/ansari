import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: process.env.NODE_ENV !== "test" && !process.env.VITEST,
  environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  beforeSend(event) {
    // Strip request body data to prevent user messages from leaking to Sentry
    if (event.request) {
      delete event.request.data;
    }
    return event;
  },
});
