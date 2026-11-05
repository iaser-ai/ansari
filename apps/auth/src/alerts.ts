// The list-walk alert (spec 300, Client IP fallback; plan P-2). When per-email
// limits trip for many distinct emails in a short period, someone is likely
// walking an email list. The event carries counts and 8-character prefixes of
// the email hashes, never an email.
//
// The WhatsApp exchange's alerts (spec 329) keep the same posture: no personal
// identifier in a Sentry event. A per-key alert names the key by its id (a
// plugin-made UUID that identifies a credential, not a person, and that `list`
// prints), so the operator can act on it. The one personal id an operator
// needs, an ineligible user's, goes only in a server log line.
import { limits } from '@ansari/auth';
import * as Sentry from '@sentry/node';

export type ListWalkAlert = {
  /** Distinct emails that hit a per-email limit inside the window. */
  distinctEmails: number;
  /** The window, in seconds. */
  windowSeconds: number;
  /** First 8 hex characters of sha256(normalized email), a sample. */
  hashPrefixes: string[];
};

export const LIST_WALK_MESSAGE = 'auth: per-email limits tripped across many emails (list walk?)';

/**
 * Failed sign-ins over SIGN_IN_FAILED_ALERT in one window, every email
 * together (a spray under the per-email lock). Nothing is refused.
 */
export type FailedSignInAlert = {
  /** Failed sign-ins in the window, every email together. */
  failedSignIns: number;
  /** The window, in seconds. */
  windowSeconds: number;
  /** failedSignIns per minute over the window. */
  perMinute: number;
  /** Distinct emails that failed inside the window. */
  distinctEmails: number;
  /** First 8 hex characters of sha256(normalized email), a sample. */
  hashPrefixes: string[];
};

export const FAILED_SIGN_IN_MESSAGE = 'auth: failed sign-ins over the alert threshold, every email together (spray?)';

/** The exchange's path: the route, app.ts, the outage probe and a docs test read it from here. */
export const WHATSAPP_SESSION_PATH = '/api/whatsapp/session';

/**
 * Headers an event may keep: none is a credential, and the user agent is one
 * of the few things that tells a botnet spray from a broken client.
 */
const KEPT_HEADERS = new Set(['host', 'user-agent', 'content-type']);

/**
 * Sentry's request-data integration attaches the in-flight request (headers,
 * cookies, query string and body) to every event raised while it is handled:
 * a sign-in's email and password, a bearer. `sendDefaultPii: false` does not
 * cover bodies or the Authorization header, so every event keeps only the
 * request's method, path and the headers in KEPT_HEADERS. That includes the
 * WhatsApp exchange (spec 329): its body carries the BSUID and the phone
 * number, and its `Authorization` header the service key.
 */
export function scrubRequestEvent<E extends Sentry.Event>(event: E): E {
  const request = event.request;
  if (!request) return event;
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).filter(([name]) => KEPT_HEADERS.has(name.toLowerCase()))
  );
  event.request = { method: request.method, url: request.url?.split('?')[0], headers };
  return event;
}

/**
 * The service's Sentry options beside the DSN and environment; tests add only a transport.
 * No breadcrumbs, service-wide: an HTTP breadcrumb carries its request's query
 * string, and the Console integration records every `console` line as a
 * breadcrumb that rides on the next event, so the ineligible-user log line (a
 * user id) would reach Sentry with that alert. Nothing here relies on
 * breadcrumbs (as `SCRIPT_SENTRY_OPTIONS` for the scripts).
 */
export const SERVICE_SENTRY_OPTIONS = {
  sendDefaultPii: false,
  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
  beforeSend: scrubRequestEvent,
} as const;

export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) return;
  Sentry.init({ dsn, environment, ...SERVICE_SENTRY_OPTIONS });
}

/** One Sentry event (plus a log line with the same fields). */
export function sendFailedSignInAlert(alert: FailedSignInAlert): void {
  console.warn(FAILED_SIGN_IN_MESSAGE, alert);
  Sentry.captureMessage(FAILED_SIGN_IN_MESSAGE, {
    level: 'warning',
    tags: { alert: 'auth-failed-sign-ins' },
    extra: { ...alert },
  });
}

/** One Sentry event (plus a log line with the same fields). */
export function sendListWalkAlert(alert: ListWalkAlert): void {
  console.warn(LIST_WALK_MESSAGE, alert);
  Sentry.captureMessage(LIST_WALK_MESSAGE, {
    level: 'warning',
    tags: { alert: 'auth-list-walk' },
    extra: { ...alert },
  });
}

/**
 * Every exchange alert, as Sentry receives it: key ids, counts, thresholds and
 * windows only. The fire-once kinds (`key-refused`, `unauthorized-volume`,
 * `ineligible-user`, `service-user-unresolvable`) mark the first occurrence (or
 * the threshold crossing) in their window and carry no count of their own: a
 * count read at the moment of firing is always 1 or the threshold.
 */
export type ExchangeAlert =
  /** A key's exchanges in its current rate-limit window reached WHATSAPP_EXCHANGE_KEY_ALERT. */
  | { kind: 'key-window-volume'; keyId: string; requests: number; windowSeconds: number; threshold: number }
  /** A key's exchanges since its last daily refill reached WHATSAPP_EXCHANGE_DAILY_ALERT. */
  | { kind: 'key-daily-volume'; keyId: string; requests: number; threshold: number }
  /** The plugin refused a key for its budget (USAGE_EXCEEDED) or its window (RATE_LIMITED); the caller saw a 401. */
  | { kind: 'key-refused'; code: KeyRefusalCode; windowSeconds: number }
  /** 401s reached EXCHANGE_UNAUTHORIZED_ALERT in one window. */
  | { kind: 'unauthorized-volume'; windowSeconds: number; threshold: number }
  /** A user behind a `whatsapp` row may not get a token; the user id is in the server log only. */
  | { kind: 'ineligible-user'; windowSeconds: number }
  /** The WhatsApp service user is missing or not unique: every exchange is a 500. */
  | { kind: 'service-user-unresolvable'; serviceUsers: number; windowSeconds: number };

export type KeyRefusalCode = 'USAGE_EXCEEDED' | 'RATE_LIMITED';

export const EXCHANGE_ALERT_MESSAGE = 'auth: WhatsApp exchange alert';

/** One Sentry event (plus a log line with the same fields). */
export function sendExchangeAlert(alert: ExchangeAlert): void {
  console.warn(EXCHANGE_ALERT_MESSAGE, alert);
  Sentry.captureMessage(`${EXCHANGE_ALERT_MESSAGE}: ${alert.kind}`, {
    level: 'warning',
    tags: { alert: `whatsapp-exchange-${alert.kind}` },
    extra: { ...alert },
  });
}

/** The fields of a verified key the per-key alerts read, as `verifyApiKey` returns them. */
export type VerifiedKeyUsage = {
  id: string;
  requestCount: number;
  rateLimitTimeWindow: number | null;
  remaining: number | null;
  refillAmount: number | null;
  lastRefillAt: Date | string | null;
  createdAt: Date | string;
};

/** What the exchange route reports; each call is one request, the alerts decide when to send. */
export type ExchangeAlerts = {
  keyVerified(key: VerifiedKeyUsage): void;
  keyRefused(code: KeyRefusalCode): void;
  unauthorized(): void;
  ineligibleUser(userId: string, reason: string): void;
  serviceUserUnresolvable(serviceUsers: number): void;
};

export const INELIGIBLE_USER_MESSAGE = 'whatsapp exchange: ineligible user refused (repair per the service-keys runbook)';

export type ExchangeAlertOptions = {
  send?: (alert: ExchangeAlert) => void;
  now?: () => number;
};

/**
 * The exchange's alerts, deduplicated in process. The per-key counts come
 * from the key's own row (the plugin keeps them durably and resets them with
 * the window and the refill); a key's window alert fires once per window and
 * its daily alert once per refill period. The rest count in fixed
 * EXCHANGE_ALERT_WINDOW windows and fire once per window. A restart can
 * re-fire once, which errs loud.
 */
export function createExchangeAlerts({ send = sendExchangeAlert, now = Date.now }: ExchangeAlertOptions = {}): ExchangeAlerts {
  const windowMs = limits.EXCHANGE_ALERT_WINDOW * 1000;
  const keyWindowFiredAt = new Map<string, number>();
  const keyDailyFiredFor = new Map<string, string>();
  const windows = new Map<string, { start: number; count: number; fired: boolean }>();

  /** Count one event in `name`'s fixed window; true the first time the count reaches `threshold`. */
  function tally(name: string, threshold: number): boolean {
    const at = now();
    let window = windows.get(name);
    if (!window || at - window.start >= windowMs) {
      window = { start: at, count: 0, fired: false };
      windows.set(name, window);
    }
    window.count += 1;
    if (window.fired || window.count < threshold) return false;
    window.fired = true;
    return true;
  }

  const windowSeconds = limits.EXCHANGE_ALERT_WINDOW;

  return {
    keyVerified(key) {
      const keyWindowMs = key.rateLimitTimeWindow ?? 0;
      const firedAt = keyWindowFiredAt.get(key.id);
      if (
        key.requestCount >= limits.WHATSAPP_EXCHANGE_KEY_ALERT &&
        (firedAt === undefined || now() - firedAt >= keyWindowMs)
      ) {
        keyWindowFiredAt.set(key.id, now());
        send({
          kind: 'key-window-volume',
          keyId: key.id,
          requests: key.requestCount,
          windowSeconds: keyWindowMs / 1000,
          threshold: limits.WHATSAPP_EXCHANGE_KEY_ALERT,
        });
      }
      if (key.refillAmount === null || key.remaining === null) return;
      const used = key.refillAmount - key.remaining;
      const period = new Date(key.lastRefillAt ?? key.createdAt).toISOString();
      if (used >= limits.WHATSAPP_EXCHANGE_DAILY_ALERT && keyDailyFiredFor.get(key.id) !== period) {
        keyDailyFiredFor.set(key.id, period);
        send({ kind: 'key-daily-volume', keyId: key.id, requests: used, threshold: limits.WHATSAPP_EXCHANGE_DAILY_ALERT });
      }
    },
    keyRefused(code) {
      if (tally(`refused:${code}`, 1)) send({ kind: 'key-refused', code, windowSeconds });
    },
    unauthorized() {
      const { max } = limits.EXCHANGE_UNAUTHORIZED_ALERT;
      if (tally('unauthorized', max)) send({ kind: 'unauthorized-volume', windowSeconds, threshold: max });
    },
    ineligibleUser(userId, reason) {
      console.warn(INELIGIBLE_USER_MESSAGE, { userId, reason });
      if (tally('ineligible', 1)) send({ kind: 'ineligible-user', windowSeconds });
    },
    serviceUserUnresolvable(serviceUsers) {
      if (tally('service-user', 1)) send({ kind: 'service-user-unresolvable', serviceUsers, windowSeconds });
    },
  };
}
