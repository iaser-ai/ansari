/**
 * Sentry: how this service tells an operator about a fault.
 *
 * Python counterpart: the `sentry_sdk.init(...)` block at the top of `app/main.py` and the `set_tag` / `set_context` /
 * `capture_exception` calls spread through the services. Here the services only know the small `ErrorReporter` function
 * (`errorReporter.ts`); `sentryReporter` below is the one that really sends.
 *
 * The scrubbing follows `apps/auth/src/alerts.ts`, which has the reasoning and a test that proves it. Sentry's request-data
 * integration attaches the in-flight request (headers, cookies, query string, body) to every event raised while that request
 * is handled, and `sendDefaultPii: false` covers neither bodies nor the `Authorization` header. A webhook body carries the
 * sender's BSUID, phone number and message text, and the handshake's query string carries the verify token, so every event
 * keeps only the request's method, path and a few harmless headers.
 *
 * Differences from Python:
 * - Python also sampled traces and profiles (20% in production). Not ported: a trace records each request's URL, and the
 *   handshake URL holds the verify token. Error reporting is what the service used Sentry for.
 * - Python filtered out log events containing "HTTP exception: 401" and "403", which its Sentry logging integration would
 *   otherwise have sent. Nothing here sends log lines to Sentry, so there is nothing to filter.
 */
import * as Sentry from '@sentry/node';
import type { ErrorReporter } from './errorReporter';

/** Headers an event may keep: none is a credential, and the user agent says who is calling. */
const KEPT_HEADERS = new Set(['host', 'user-agent', 'content-type']);

/** Reduce an event's request to its method, its URL without the query string, and the headers in `KEPT_HEADERS`. */
export function scrubRequestEvent<E extends Sentry.Event>(event: E): E {
  const request = event.request;
  if (!request) return event;
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).filter(([name]) => KEPT_HEADERS.has(name.toLowerCase())),
  );
  event.request = { method: request.method, url: request.url?.split('?')[0], headers };
  return event;
}

/**
 * Everything this service sets besides the DSN and the environment (tests add only a transport).
 * No breadcrumbs: an HTTP breadcrumb carries its request's query string, and every console line would ride along on the next
 * event.
 */
export const SENTRY_OPTIONS = {
  sendDefaultPii: false,
  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
  beforeSend: scrubRequestEvent,
} as const;

/**
 * Start Sentry. Without a DSN it stays off (Python: `if SENTRY_DSN and deployment_type != "local"`, now `development`; the caller checks the
 * deployment type).
 */
export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) return;
  Sentry.init({ dsn, environment, ...SENTRY_OPTIONS });
}

/** One Sentry event per call, tagged `error_type` and carrying the context (Python: `set_tag` + `set_context`). */
export const sentryReporter: ErrorReporter = (error, report) => {
  Sentry.withScope((scope) => {
    scope.setTag('error_type', report.errorType);
    if (report.context) scope.setContext('details', report.context);
    Sentry.captureException(error);
  });
};

/** Send what is still queued, for the moments before the process exits. */
export async function flushSentry(timeoutMs: number): Promise<void> {
  await Sentry.flush(timeoutMs);
}
