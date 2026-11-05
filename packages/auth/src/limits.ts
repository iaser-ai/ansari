// Every rate-limit number for the auth service (spec 300, plan P-2), and the
// only place they are written down. createAuth() builds better-auth's router
// rules from ROUTER_RULES; apps/auth's own limiters (sign-in, sign-up and reset
// per email, the global ceilings, the session-token and account budgets) read
// the rest. Tests import these constants rather than repeating numbers, so
// amending a number after the production baselines (B-1 to B-4) touches this
// file alone.
//
// No limit on a path apps/api's /v2/users layer calls is keyed by client IP
// (owner amendment, 2026-10-17). The layer reaches apps/auth anonymously over
// the public domain, so apps/auth sees apps/api's egress IP on every legacy
// call: a per-IP rule there would put every mobile user in one bucket. Those
// paths are limited per email, per session token, per user or globally here,
// and per client IP by apps/api itself (apps/api `lib/auth-service/limits.ts`).
// This is TEMPORARY, until the legacy system is replaced.
//
// Windows are in seconds, as better-auth's `customRules` expects.

export type LimitRule = { readonly window: number; readonly max: number };

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * better-auth's global default, per client IP, for any router path without a
 * rule. It never applies to a path the layer calls (each is `false` below).
 * apps/api's JWKS fetch falls under it, at most one fetch per 30 s cooldown.
 */
export const DEFAULT_RULE: LimitRule = { window: MINUTE, max: 100 };

/** Reset request, per normalized email (stored hashed), every request, unknown emails included. */
export const RESET_REQUEST_PER_EMAIL: LimitRule = { window: HOUR, max: 3 };

/**
 * Reset request, every caller together: max(30/min, 10 × B-3 peak per minute).
 * 30 until B-3 is measured; it must never bind on real traffic.
 */
export const RESET_REQUEST_GLOBAL: LimitRule = { window: MINUTE, max: 30 };

/**
 * Reset consume (`/reset-password`), every caller together. Tokens are random,
 * so this only stops hammering; it must never bind on real traffic.
 */
export const RESET_CONSUME_GLOBAL: LimitRule = { window: MINUTE, max: 30 };

/**
 * Session → JWT exchange (`/token`), per session token (stored hashed), counted
 * only for a bearer shaped like a session token. The released mobile client
 * refreshes concurrently with no single-flight guard, so bursts must pass.
 */
export const TOKEN_EXCHANGE_PER_SESSION: LimitRule = { window: MINUTE, max: 60 };

/** Each account endpoint (`/api/account`: me, revoke-sessions, delete), per user. */
export const ACCOUNT_ENDPOINT: LimitRule = { window: MINUTE, max: 60 };

/** Sign-in per normalized email, FAILED attempts only; locks the email for the window. */
export const SIGN_IN_PER_EMAIL: LimitRule = { window: MINUTE, max: 5 };

/** Sign-up per normalized email, every request. */
export const SIGN_UP_PER_EMAIL: LimitRule = { window: MINUTE, max: 3 };

/**
 * The global sign-up ceiling, max(30/min, 10 × B-1 peak per minute). 30 until
 * B-1 is measured; it must never bind on real traffic.
 */
export const SIGN_UP_GLOBAL: LimitRule = { window: MINUTE, max: 30 };

/**
 * An ALERT, never a cap (security review, batch 5, H): when this many sign-ins
 * fail in the window, every email together, apps/auth sends one Sentry event
 * per window (counts, the rate, distinct emails, hash prefixes; ids only) and
 * refuses nothing. It catches a sprayer that stays under SIGN_IN_PER_EMAIL for
 * each email, which no limit and not the list-walk alert would see. 30 per
 * minute until B-4 is measured; the owner sets the number from it.
 *
 * OWNER OPTION, NOT BUILT: a refusal ceiling on failed sign-ins could be added
 * beside it at a much higher floor (max(600 per minute, 10 x the B-4 peak)).
 * The trade-off: once tripped it refuses every sign-in, the right password
 * included, so anyone able to send that many wrong passwords can switch sign-in
 * off for every user, and it does not slow a sprayer (an attempt's outcome is
 * unknown until the password is checked). The per-email lock stays the primary
 * control.
 */
export const SIGN_IN_FAILED_ALERT: LimitRule = { window: MINUTE, max: 30 };

/** List-walk alert when this many distinct emails hit a per-email limit in the window. */
export const LIST_WALK_ALERT = { window: 10 * MINUTE, distinctEmails: 20 } as const;

/**
 * WhatsApp token exchange (spec 329), per user (keyed by the user id, never the
 * BSUID), spent on the pool before the lock. Normal use is about one exchange
 * per 15-minute token, plus one after a restart; a looping client for one user
 * hits 429 at once.
 */
export const WHATSAPP_EXCHANGE_PER_USER: LimitRule = { window: 15 * MINUTE, max: 6 };

/** The longest window above. better-auth's pruner keeps rows at least this long. */
export const LONGEST_WINDOW = Math.max(
  ...[
    DEFAULT_RULE,
    RESET_REQUEST_PER_EMAIL,
    RESET_REQUEST_GLOBAL,
    RESET_CONSUME_GLOBAL,
    TOKEN_EXCHANGE_PER_SESSION,
    ACCOUNT_ENDPOINT,
    SIGN_IN_PER_EMAIL,
    SIGN_UP_PER_EMAIL,
    SIGN_UP_GLOBAL,
    SIGN_IN_FAILED_ALERT,
    LIST_WALK_ALERT,
    WHATSAPP_EXCHANGE_PER_USER,
  ].map((rule) => rule.window)
);

/**
 * better-auth router rules, keyed by the path the router sees (basePath
 * stripped). `false` switches the router's per-IP limiter off for that path,
 * the global default included (better-auth returns before choosing a bucket);
 * apps/auth's own limiters enforce the rules above instead. Absent would fall
 * back to better-auth's built-in per-IP rules (sign-in/sign-up 3 per 10 s,
 * reset request 3 per 60 s) or the default.
 *
 * These are exactly the five better-auth paths apps/api's layer calls
 * (`lib/auth-service/legacy.ts`); every other path, `/get-session` included,
 * keeps the per-IP default.
 *
 * PROPOSAL for the owner, after the baselines (security review, batch 4, D; see
 * also SIGN_IN_FAILED_ALERT's owner option):
 * with the per-IP rules gone, a client calling these paths directly from one IP
 * is bounded only by the per-email, per-session and global rules. A HIGH per-IP
 * ceiling on each would bound it again, if it is sized so the layer's aggregate
 * from apps/api's one egress IP never binds: max(600 per minute, 10 x the B-4
 * peak) for sign-in and /token, 10 x the B-1 peak for sign-up, as the global
 * ceilings are sized. A rule here would be `{ window: 60, max: N }` in place of
 * `false`. No number is chosen without B-1 and B-4.
 */
export const ROUTER_RULES: Readonly<Record<string, false>> = {
  '/sign-in/email': false,
  '/sign-up/email': false,
  '/request-password-reset': false,
  '/reset-password': false,
  '/token': false,
};

// Service keys (spec 329). These limits live in each key's own row (the
// api-key plugin enforces them at verify), not in `rate_limit`, and are set by
// the operator through apps/auth's service-keys script. Unlike the rules above,
// windows here are in MILLISECONDS, as the plugin stores them.

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

/** A service key's limits, in the plugin's field names and units. */
export type KeyLimits = {
  /** Requests allowed per window. */
  readonly rateLimitMax: number;
  /** The window, in milliseconds. */
  readonly rateLimitTimeWindow: number;
  /** The daily budget: `remaining` is refilled to this every `refillInterval`. */
  readonly refillAmount: number;
  /** Always KEY_REFILL_INTERVAL: the budget is daily. */
  readonly refillInterval: number;
};

/** A key's budget refills once a day (spec 329: a daily budget). */
export const KEY_REFILL_INTERVAL = DAY_MS;

/**
 * The WhatsApp key's initial values (owner decision 3, sized by judgement in
 * plan 329): 60 per minute bounds a leaked key or a looping client within a
 * minute; 3,000 a day is hundreds of conversations at one exchange per 15
 * minutes, with headroom. The runbook's issuance command passes these.
 */
export const WHATSAPP_KEY_INITIAL: KeyLimits = {
  rateLimitMax: 60,
  rateLimitTimeWindow: 60 * SECOND_MS,
  refillAmount: 3000,
  refillInterval: KEY_REFILL_INTERVAL,
};

/**
 * What the service-keys script accepts for a key (inclusive). Wide on purpose:
 * raising a key's values never needs these to change.
 */
export const WHATSAPP_KEY_BOUNDS = {
  rateLimitMax: { min: 1, max: 100_000 },
  rateLimitTimeWindow: { min: SECOND_MS, max: DAY_MS },
  refillAmount: { min: 1, max: 10_000_000 },
} as const;

// The WhatsApp exchange's session and transaction (spec 329), in MILLISECONDS.

/** A session the exchange signs from must outlive the token's `exp` by at least this much. */
export const SESSION_MARGIN = 5 * 60 * SECOND_MS;

/**
 * The exchange's `lock_timeout`: a held user row fails one request, not the pool.
 * Owned by `apps/auth/scripts/probes/exchange-outage-probe.ts` (real Postgres):
 * pglite has one connection and cannot hold a lock from another.
 */
export const EXCHANGE_LOCK_TIMEOUT = 2 * SECOND_MS;

/** The exchange's `statement_timeout`, for any slow statement in its transaction. */
export const EXCHANGE_STATEMENT_TIMEOUT = 5 * SECOND_MS;

// The WhatsApp exchange route (spec 329). The alert numbers are ALERTS, never
// caps: each sends one Sentry event (key ids, counts, windows) and
// refuses nothing. They sit well below the key's own caps, so a surge is seen
// before anything is refused.

/**
 * How long a successful `auth.apikey` relation check is trusted, in ms. Every
 * plugin refusal runs the check, so an outage the plugin reports as an unknown
 * key is a 500, not a 401; this bounds that cost under an unknown-key flood,
 * and is also the length of the misclassification residual. Its outage
 * behaviour is owned by `apps/auth/scripts/probes/exchange-outage-probe.ts`
 * (database stopped under a production-mode service).
 */
export const APIKEY_RELATION_CHECK_TTL = 5 * SECOND_MS;

/**
 * The exchange's request body limit, in bytes: `bsuid` ≤ 256 plus JSON, with room
 * for the `phone_number` the consumer may still send (accepted and ignored).
 */
export const EXCHANGE_BODY_LIMIT = 1024;

/**
 * Per-key alert: this many exchanges inside one of the key's rate-limit
 * windows (the plugin's `requestCount`; 60 s for WHATSAPP_KEY_INITIAL). One
 * third of WHATSAPP_KEY_INITIAL.rateLimitMax.
 */
export const WHATSAPP_EXCHANGE_KEY_ALERT = 20;

/**
 * Per-key alert: this many exchanges since the key's last daily refill
 * (`refillAmount − remaining`). One third of WHATSAPP_KEY_INITIAL.refillAmount.
 */
export const WHATSAPP_EXCHANGE_DAILY_ALERT = 1000;

/**
 * The window of the exchange's in-process alerts, in seconds: the 401 volume,
 * and once-per-window events for USAGE_EXCEEDED, RATE_LIMITED, an ineligible
 * user and an unresolvable service user.
 */
export const EXCHANGE_ALERT_WINDOW = 5 * MINUTE;

/** 401s from the exchange in one EXCHANGE_ALERT_WINDOW. A healthy consumer sees none outside a rotation. */
export const EXCHANGE_UNAUTHORIZED_ALERT: LimitRule = { window: EXCHANGE_ALERT_WINDOW, max: 20 };
