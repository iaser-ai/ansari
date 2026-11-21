/**
 * How the services tell an operator about a fault (Python: `sentry_sdk.set_tag` + `set_context` + `capture_exception`).
 *
 * The services only know this small shape. The HTTP layer (plan phase 5) passes in the function that sends it to Sentry,
 * so no service imports Sentry and a test can hand in a function that just records the call.
 */
export interface ErrorReport {
  /** Sentry's `error_type` tag: what kind of fault this is, e.g. `meta_api_failure`. */
  errorType: string;
  /** Extra fields shown with the event. Never put a phone number, BSUID, token or message text here. */
  context?: Record<string, unknown>;
}

export type ErrorReporter = (error: unknown, report: ErrorReport) => void;

/** Reports nothing. The default until a real reporter is wired in. */
export const noopErrorReporter: ErrorReporter = () => {};
