// The WhatsApp token exchange (spec 329): the WhatsApp service, holding a
// service key, trades a BSUID for that user's JWT, the same EdDSA 15-minute
// `{sub, sid}` token apps/auth issues every client.
//
//   POST /api/whatsapp/session
//     Authorization: Bearer <api key>
//     { "bsuid": "<BSUID>" }
//
// A `phone_number` field, which the WhatsApp service may still send, is
// accepted in any shape and ignored: never read, stored, logged or echoed
// (spec 329 §5, owner amendment 2).
//
//   200 { token }  400 Invalid request  401 Unauthorized (every key refusal,
//   one body)  403 Forbidden (banned)  429 Too many requests (this user's
//   budget, with X-Retry-After)  500 Internal error (anything else)
//
// Order: the key, then the body (parsed only after the key, with a byte
// limit), then the user, the per-user budget on the pool, and the locked
// decision (packages/auth `whatsapp.ts`). No response, log line or Sentry
// event carries the bearer, the BSUID, the phone number or the body; errors
// log `{name, code}` only.
//
// The router answers every request to its path itself (any other method is a
// bare 404) and is mounted ahead of `corsFor`, so no response from it carries
// an `Access-Control-*` header and a browser can never use it. It is outside
// Better Auth's handler path, so no router per-IP rule applies: the WhatsApp
// service calls from one egress IP, and the key's own limits and the per-user
// budget are the throttle.
import {
  consumeWindow,
  limits,
  redactError,
  schema,
  serviceUsers,
  whatsapp,
} from '@ansari/auth';
import express, { Router, type NextFunction, type Request, type Response } from 'express';

import {
  createExchangeAlerts,
  WHATSAPP_SESSION_PATH,
  type ExchangeAlerts,
  type KeyRefusalCode,
} from '../alerts';
import type { ServiceDeps } from '../app';

export { WHATSAPP_SESSION_PATH };

const SERVICE = 'whatsapp';
const REQUIRED_PERMISSIONS = { whatsapp: [...serviceUsers.SERVICES.whatsapp.permissions.whatsapp] };

/**
 * A non-empty string of at most 256 characters, with no whitespace, control
 * character or format character (zero-width, bidi overrides): sanity bounds
 * only (spec 329 item 9). A format character would let two BSUIDs that look
 * identical name two users.
 */
const BSUID = /^[^\s\p{Cc}\p{Cf}]{1,256}$/u;

export const exchangeLimitKey = (userId: string) => `sub:${userId}|${WHATSAPP_SESSION_PATH}`;

export type ExchangeOptions = {
  alerts?: ExchangeAlerts;
  /** The clock for the relation-check cache; tests advance it. */
  now?: () => number;
};

type ExchangeBody = { bsuid: string };

const KEY_REFUSAL_CODES: readonly string[] = ['USAGE_EXCEEDED', 'RATE_LIMITED'] satisfies KeyRefusalCode[];

function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  // The scheme is case-insensitive (RFC 7235 §2.1): a client's `bearer` must
  // not get the 401 a revoked key gets.
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * The sanity bounds (spec 329 §2, step 2); null when the body fails them. Only
 * `bsuid` is read: every other field is ignored.
 */
function exchangeBody(body: unknown): ExchangeBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { bsuid } = body as Record<string, unknown>;
  if (typeof bsuid !== 'string' || !BSUID.test(bsuid)) return null;
  return { bsuid };
}

const unauthorized = (res: Response) => res.status(401).json({ message: 'Unauthorized' });
const invalidRequest = (res: Response) => res.status(400).json({ message: 'Invalid request' });
const internalError = (res: Response) => res.status(500).json({ message: 'Internal error' });

export function whatsappRouter({ auth, db }: ServiceDeps, options: ExchangeOptions = {}): Router {
  const alerts = options.alerts ?? createExchangeAlerts();
  const now = options.now ?? Date.now;
  const router = Router();

  let relationCheckedAt: number | null = null;

  /**
   * The plugin reports a database failure (an outage, `auth.apikey` missing)
   * as INVALID_API_KEY, the code of an unknown key. A query on `auth.apikey`
   * itself (not `select 1`, which passes with the relation gone) tells them
   * apart; a success is trusted for APIKEY_RELATION_CHECK_TTL. Throws on failure.
   */
  async function checkApiKeyRelation(): Promise<void> {
    const at = now();
    if (relationCheckedAt !== null && at - relationCheckedAt < limits.APIKEY_RELATION_CHECK_TTL) return;
    await db.select({ id: schema.apikey.id }).from(schema.apikey).limit(1);
    relationCheckedAt = at;
  }

  function refuse(res: Response): void {
    alerts.unauthorized();
    unauthorized(res);
  }

  function fail(res: Response, err: unknown): void {
    console.error('whatsapp exchange failed:', err instanceof Error ? redactError(err) : { name: 'unknown' });
    if (!res.headersSent) internalError(res);
  }

  /** The key: verified with `whatsapp: mint` and owned by the WhatsApp service user. */
  async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = bearerOf(req);
      if (!key) return refuse(res);
      const verified = await auth.api.verifyApiKey({ body: { key, permissions: REQUIRED_PERMISSIONS } });
      if (!verified.valid || !verified.key) {
        const code = verified.error?.code;
        if (typeof code === 'string' && KEY_REFUSAL_CODES.includes(code)) {
          alerts.keyRefused(code as KeyRefusalCode);
        }
        await checkApiKeyRelation();
        return refuse(res);
      }
      alerts.keyVerified(verified.key);
      const owner = await serviceUsers.findServiceUser(db, SERVICE);
      if (owner.kind !== 'one') {
        alerts.serviceUserUnresolvable(owner.kind === 'many' ? owner.ids.length : 0);
        return fail(res, new Error('whatsapp service user unresolvable'));
      }
      if (verified.key.referenceId !== owner.user.id) return refuse(res);
      next();
    } catch (err) {
      fail(res, err);
    }
  }

  /** body-parser 2.x skips a body it does not handle instead of raising, so the media type is checked here. */
  function requireJson(req: Request, res: Response, next: NextFunction): void {
    if (req.is('application/json') !== 'application/json') return void invalidRequest(res);
    next();
  }

  /** The parser's errors (malformed JSON, over the limit, a bad charset) → the one 400, never Express's error page. */
  // Express recognizes an error handler by its four parameters, so `_next` stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function parseFailure(_err: unknown, _req: Request, res: Response, _next: NextFunction): void {
    invalidRequest(res);
  }

  async function exchange(req: Request, res: Response): Promise<void> {
    try {
      const body = exchangeBody(req.body);
      if (!body) return void invalidRequest(res);
      const { userId } = await whatsapp.resolveOrCreateWhatsappUser(db, body.bsuid);

      // On the pool, outside the locking transaction: a refusal inside it
      // would roll the counter back, and the budget would never bind.
      const rule = limits.WHATSAPP_EXCHANGE_PER_USER;
      const { count, retryAfter } = await consumeWindow(db, exchangeLimitKey(userId), rule);
      if (count > rule.max) {
        res.status(429).set('X-Retry-After', String(retryAfter)).json({ message: 'Too many requests' });
        return;
      }

      const outcome = await whatsapp.issueWhatsappToken(auth, db, { userId, ...body });
      switch (outcome.kind) {
        case 'issued':
          res.status(200).json({ token: outcome.token });
          return;
        case 'banned':
          res.status(403).json({ message: 'Forbidden' });
          return;
        case 'ineligible':
          alerts.ineligibleUser(userId, outcome.reason);
          internalError(res);
          return;
        case 'user-gone':
          internalError(res);
          return;
        default: {
          // A new outcome kind fails to compile here, and answers 500 rather than hanging.
          const unhandled: never = outcome;
          void unhandled;
          internalError(res);
          return;
        }
      }
    } catch (err) {
      fail(res, err);
    }
  }

  router.post(
    '/',
    authenticate,
    requireJson,
    express.json({ limit: limits.EXCHANGE_BODY_LIMIT }),
    parseFailure,
    exchange
  );
  // Every other method (OPTIONS included) and every sub-path ends here, so
  // nothing falls through to corsFor.
  router.use((_req: Request, res: Response) => {
    res.status(404).end();
  });
  return router;
}
