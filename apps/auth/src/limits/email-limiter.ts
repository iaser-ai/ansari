// apps/auth's own limiters, run as better-auth hooks (createAuth's
// `extensions`), on `auth.rate_limit` so every instance shares one budget.
//
// None is keyed by client IP (owner amendment, 2026-10-17; TEMPORARY until the
// legacy system is replaced): apps/api's /v2/users layer calls these paths
// anonymously, so they all arrive with apps/api's IP, and the router has no
// per-IP rule on them (packages/auth `limits.ts` ROUTER_RULES). apps/api limits
// the layer's routes per client IP itself.
//
//   - `/sign-in/email`: per email, FAILED attempts only. The fifth failure in a
//     window locks the email until the window ends, even for the right
//     password. A refused attempt is not counted, so it cannot extend the lock.
//   - `/sign-up/email`: per email, every request, plus a global ceiling.
//   - `/request-password-reset`: per email and a global ceiling, every request
//     counted against both (an unknown email included), the same 429 for both.
//   - `/reset-password`: a global ceiling.
//   - `/token`: per session token (the bearer, stored hashed), counted only for a
//     bearer shaped like a session token (`sessionTokenOf`), so a spray of random
//     bearers writes no rows. `/get-session`, which the layer never calls, stays
//     under the router's per-IP default.
//   - The list-walk alert, when per-email limits trip for many distinct emails.
//   - The failed-sign-in alert (SIGN_IN_FAILED_ALERT): every failed sign-in,
//     every email together, alerts once per window over the threshold. It
//     refuses nothing.
//
// Keys never hold a raw email or token: `email:<sha256(normalized)>|<path>`,
// `session:<sha256(token)>|<path>`.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  consumeWindow,
  isAuthError,
  keysSeenSince,
  limits,
  normalizeEmail,
  peekWindow,
  tooManyRequests,
  touchKey,
  type AuthExtensions,
  type AuthHookContext,
  type Db,
} from '@ansari/auth';

import {
  sendFailedSignInAlert,
  sendListWalkAlert,
  type FailedSignInAlert,
  type ListWalkAlert,
} from '../alerts';

const SIGN_IN = '/sign-in/email';
const SIGN_UP = '/sign-up/email';
const RESET_REQUEST = '/request-password-reset';
const RESET_CONSUME = '/reset-password';
const TOKEN_EXCHANGE = '/token';

/** better-auth 1.7.7's session token: `generateId(32)`, 32 of `[A-Za-z0-9]` (`internal-adapter.mjs`). */
const SESSION_TOKEN = /^[A-Za-z0-9]{32}$/;
/**
 * The signed cookie form the bearer() plugin also accepts: `<token>.<HMAC-SHA256>`, the signature
 * in base64 (better-call's `signCookieValue`: standard, padded) or base64url, often URI-encoded.
 */
const SIGNED_SESSION_TOKEN = /^([A-Za-z0-9]{32})\.([A-Za-z0-9+/_-]{43}=?)$/;

/**
 * The session token a bearer carries, or null when it cannot be one, so it is
 * never counted: anything not shaped like better-auth's token, and a signed form
 * whose HMAC under BETTER_AUTH_SECRET does not verify (the bearer() plugin drops
 * those too). An unsigned well-formed value is counted: the plugin signs it
 * itself, so its shape is all there is to check before the session lookup.
 */
export function sessionTokenOf(bearer: string, secret: string): string | null {
  if (SESSION_TOKEN.test(bearer)) return bearer;
  let raw = bearer;
  if (raw.includes('%')) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  const signed = SIGNED_SESSION_TOKEN.exec(raw);
  if (!signed) return null;
  const [, token = '', signature = ''] = signed;
  const wanted = createHmac('sha256', secret).update(token, 'utf8').digest();
  // Node's base64 decoder reads both alphabets, padded or not.
  const given = Buffer.from(signature, 'base64');
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? token : null;
}

const WALK_PREFIX = 'walk:';
const WALK_ALERT_KEY = 'alert|list-walk';
const FAILED_PREFIX = 'failed:';
const FAILED_COUNT_KEY = `global|failed|${SIGN_IN}`;
const FAILED_ALERT_KEY = 'alert|failed-sign-ins';
/** How many hash prefixes the failed-sign-in alert samples. */
const FAILED_SAMPLE = 20;
const HASH_PREFIX_LENGTH = 8;

export function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');
}

export const emailKey = (email: string, path: string) => `email:${emailHash(email)}|${path}`;
export const sessionKey = (token: string, path: string) =>
  `session:${createHash('sha256').update(token, 'utf8').digest('hex')}|${path}`;
export const globalKey = (path: string) => `global|${path}`;

export type PerimeterOptions = {
  db: Db;
  alert?: (alert: ListWalkAlert) => void;
  failedSignInAlert?: (alert: FailedSignInAlert) => void;
  now?: () => number;
};

function emailOf(ctx: AuthHookContext): string | null {
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim().length > 0 ? email : null;
}

/** The bearer session token, as the bearer() plugin reads it; null without one. */
function bearerOf(ctx: AuthHookContext): string | null {
  const headers = ctx.request?.headers ?? ctx.headers;
  const match = /^Bearer (\S+)$/i.exec(headers?.get('authorization') ?? '');
  return match?.[1] ?? null;
}

export function createPerimeterHooks(options: PerimeterOptions): AuthExtensions {
  const { db } = options;
  const alert = options.alert ?? sendListWalkAlert;
  const failedSignInAlert = options.failedSignInAlert ?? sendFailedSignInAlert;
  const now = options.now ?? Date.now;

  /**
   * Record that this email tripped a per-email limit, and alert (at most once
   * per window, across instances) when enough distinct emails have.
   */
  async function recordLimitHit(email: string): Promise<void> {
    const at = now();
    const { window, distinctEmails } = limits.LIST_WALK_ALERT;
    await touchKey(db, `${WALK_PREFIX}${emailHash(email)}`, at);
    const seen = await keysSeenSince(db, WALK_PREFIX, at - window * 1000, distinctEmails);
    if (seen.total < distinctEmails) return;
    const gate = await consumeWindow(db, WALK_ALERT_KEY, { window, max: 1 }, at);
    if (gate.count !== 1) return;
    alert({
      distinctEmails: seen.total,
      windowSeconds: window,
      hashPrefixes: seen.sample.map((key) =>
        key.slice(WALK_PREFIX.length, WALK_PREFIX.length + HASH_PREFIX_LENGTH)
      ),
    });
  }

  async function limitResetRequest(ctx: AuthHookContext): Promise<void> {
    const at = now();
    const email = emailOf(ctx);
    // Count against both before deciding, so each refusal still costs budget.
    const [global, perEmail] = await Promise.all([
      consumeWindow(db, globalKey(RESET_REQUEST), limits.RESET_REQUEST_GLOBAL, at),
      email
        ? consumeWindow(db, emailKey(email, RESET_REQUEST), limits.RESET_REQUEST_PER_EMAIL, at)
        : null,
    ]);
    if (perEmail && perEmail.count > limits.RESET_REQUEST_PER_EMAIL.max) {
      throw tooManyRequests(perEmail.retryAfter);
    }
    if (global.count > limits.RESET_REQUEST_GLOBAL.max) throw tooManyRequests(global.retryAfter);
  }

  async function limitResetConsume(): Promise<void> {
    const state = await consumeWindow(db, globalKey(RESET_CONSUME), limits.RESET_CONSUME_GLOBAL, now());
    if (state.count > limits.RESET_CONSUME_GLOBAL.max) throw tooManyRequests(state.retryAfter);
  }

  async function limitTokenExchange(ctx: AuthHookContext): Promise<void> {
    const bearer = bearerOf(ctx);
    // No bearer, or one that cannot be a session token: better-auth finds no
    // session, and nothing is written, so a spray adds no rows.
    const token = bearer ? sessionTokenOf(bearer, ctx.context.secret) : null;
    if (!token) return;
    const rule = limits.TOKEN_EXCHANGE_PER_SESSION;
    const state = await consumeWindow(db, sessionKey(token, TOKEN_EXCHANGE), rule, now());
    if (state.count > rule.max) throw tooManyRequests(state.retryAfter);
  }

  async function refuseLockedSignIn(ctx: AuthHookContext): Promise<void> {
    const email = emailOf(ctx);
    if (!email) return;
    const rule = limits.SIGN_IN_PER_EMAIL;
    const state = await peekWindow(db, emailKey(email, SIGN_IN), rule, now());
    // No limit hit is recorded here: countFailedSignIn recorded it when the
    // lock engaged, and the lock (one window) is shorter than the list-walk
    // window, so a refusal adds nothing but a rate_limit write per request.
    if (state.count >= rule.max) throw tooManyRequests(state.retryAfter);
  }

  async function countFailedSignIn(ctx: AuthHookContext): Promise<void> {
    const email = emailOf(ctx);
    if (!email) return;
    const rule = limits.SIGN_IN_PER_EMAIL;
    const state = await consumeWindow(db, emailKey(email, SIGN_IN), rule, now());
    // The failure that engages the lock is a limit hit: a list walker that
    // stops at the limit for each email never sees a 429.
    if (state.count >= rule.max) await recordLimitHit(email);
    await countForFailedSignInAlert(email);
  }

  /**
   * Every failed sign-in, every email together: at the threshold, one alert per
   * window across instances. Never a refusal (SIGN_IN_FAILED_ALERT).
   */
  async function countForFailedSignInAlert(email: string): Promise<void> {
    const at = now();
    const { window, max } = limits.SIGN_IN_FAILED_ALERT;
    const [state] = await Promise.all([
      consumeWindow(db, FAILED_COUNT_KEY, { window, max }, at),
      touchKey(db, `${FAILED_PREFIX}${emailHash(email)}`, at),
    ]);
    if (state.count < max) return;
    const gate = await consumeWindow(db, FAILED_ALERT_KEY, { window, max: 1 }, at);
    if (gate.count !== 1) return;
    const seen = await keysSeenSince(db, FAILED_PREFIX, at - window * 1000, FAILED_SAMPLE);
    failedSignInAlert({
      failedSignIns: state.count,
      windowSeconds: window,
      perMinute: Math.round((state.count * 60) / window),
      distinctEmails: seen.total,
      hashPrefixes: seen.sample.map((key) =>
        key.slice(FAILED_PREFIX.length, FAILED_PREFIX.length + HASH_PREFIX_LENGTH)
      ),
    });
  }

  async function limitSignUp(ctx: AuthHookContext): Promise<void> {
    const at = now();
    const email = emailOf(ctx);
    const [global, perEmail] = await Promise.all([
      consumeWindow(db, globalKey(SIGN_UP), limits.SIGN_UP_GLOBAL, at),
      email
        ? consumeWindow(db, emailKey(email, SIGN_UP), limits.SIGN_UP_PER_EMAIL, at)
        : null,
    ]);
    if (email && perEmail && perEmail.count > limits.SIGN_UP_PER_EMAIL.max) {
      await recordLimitHit(email);
      throw tooManyRequests(perEmail.retryAfter);
    }
    if (global.count > limits.SIGN_UP_GLOBAL.max) throw tooManyRequests(global.retryAfter);
  }

  return {
    async before(ctx) {
      if (ctx.path === RESET_REQUEST) return limitResetRequest(ctx);
      if (ctx.path === RESET_CONSUME) return limitResetConsume();
      if (ctx.path === TOKEN_EXCHANGE) return limitTokenExchange(ctx);
      if (ctx.path === SIGN_IN) return refuseLockedSignIn(ctx);
      if (ctx.path === SIGN_UP) return limitSignUp(ctx);
    },
    async after(ctx) {
      if (ctx.path !== SIGN_IN) return;
      if (isAuthError(ctx.context.returned)) await countFailedSignIn(ctx);
    },
  };
}
