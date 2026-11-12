// The MCP key verify route (#314): apps/api asks whether the key an MCP caller
// presented is a good `ansari-mcp` key, and learns its `client_id`.
//
//   POST /api/service/verify-key
//     Content-Type: application/json
//     { "key": "<api key>", "permissions": { "mcp": ["complete"] } }
//
//   200 { valid: true, client_id, key_id }
//   200 { valid: false }  every refusal, one body: unknown, disabled, expired,
//       exhausted, rate limited, wrong permission, another owner, a missing or
//       off-pattern client_id
//   400 Invalid request   not JSON, over the byte limit, a key out of bounds, or
//       a permission set other than the one the route serves; no key is touched
//   500 Internal error    the database, `auth.apikey`, or the service user
//
// The permission set is closed: the route serves exactly `{ mcp: ['complete'] }`
// for the `ansari-mcp` service user, so it cannot verify or spend a WhatsApp
// key under the WhatsApp permission. The key is the only credential; there is
// no shared secret. Each verify spends one unit of the key's budget and one
// rate-limit slot (the plugin's own throttle). No response, log line or Sentry
// event carries the key or the body; errors log `{name, code}` only.
//
// Like the WhatsApp exchange, the router answers every request to its path
// itself (any other method is a bare 404) and is mounted ahead of `corsFor`,
// so no response carries an `Access-Control-*` header. It is outside Better
// Auth's handler path, so no router per-IP rule applies: apps/api calls from
// its egress IP.
import { isMcpClientId, limits, redactError, serviceUsers, type Environment } from '@ansari/auth';
import express, { Router, type NextFunction, type Request, type Response } from 'express';

import { createMcpVerifyAlerts, type KeyRefusalCode, type McpVerifyAlerts } from '../alerts';
import type { ServiceDeps } from '../app';
import { createApiKeyRelationCheck } from './apikey-relation';

export const SERVICE_VERIFY_PATH = '/api/service/verify-key';

const SERVICE = 'ansari-mcp';
const SERVED_RESOURCE = 'mcp';
const SERVED_ACTIONS: readonly string[] = serviceUsers.SERVICES[SERVICE].permissions.mcp;

/** Printable ASCII with no space: sanity bounds only (a real key is 75 characters). */
const KEY = new RegExp(`^[\\x21-\\x7E]{1,${limits.VERIFY_KEY_MAX_LENGTH}}$`);

const KEY_REFUSAL_CODES: readonly string[] = ['USAGE_EXCEEDED', 'RATE_LIMITED'] satisfies KeyRefusalCode[];

export type VerifyOptions = {
  alerts?: McpVerifyAlerts;
  /** The clock for the relation-check cache; tests advance it. */
  now?: () => number;
};

/** True only for exactly `{ mcp: ['complete'] }`: no other resource, action, order or repeat. */
function isServedPermissionSet(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== 1) return false;
  const [[resource, actions]] = entries as [[string, unknown]];
  return (
    resource === SERVED_RESOURCE &&
    Array.isArray(actions) &&
    actions.length === SERVED_ACTIONS.length &&
    actions.every((action, i) => action === SERVED_ACTIONS[i])
  );
}

/** The key, when the body is within bounds and asks for the served set; null otherwise. Other fields are ignored. */
function presentedKey(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { key, permissions } = body as Record<string, unknown>;
  if (typeof key !== 'string' || !KEY.test(key)) return null;
  if (!isServedPermissionSet(permissions)) return null;
  return key;
}

const REFUSED = { valid: false } as const;
const invalidRequest = (res: Response) => res.status(400).json({ message: 'Invalid request' });
const internalError = (res: Response) => res.status(500).json({ message: 'Internal error' });

/**
 * `environment` is this deployment's ENVIRONMENT (#314 Amendment 3): only a key
 * whose stored prefix names it is served. `ansari-mcp` has no legacy window
 * (LEGACY_PREFIXES['ansari-mcp'] is empty). createApp passes it; it is the one place it is set.
 */
export function serviceVerifyRouter({ auth, db }: ServiceDeps, options: VerifyOptions, environment: Environment): Router {
  const alerts = options.alerts ?? createMcpVerifyAlerts();
  const checkApiKeyRelation = createApiKeyRelationCheck(db, options.now ?? Date.now);
  const permissions = { [SERVED_RESOURCE]: [...SERVED_ACTIONS] };
  const router = Router();

  function refuse(res: Response): void {
    alerts.unauthorized();
    res.status(200).json(REFUSED);
  }

  function fail(res: Response, err: unknown): void {
    console.error('mcp key verify failed:', err instanceof Error ? redactError(err) : { name: 'unknown' });
    if (!res.headersSent) internalError(res);
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

  async function verify(req: Request, res: Response): Promise<void> {
    try {
      const key = presentedKey(req.body);
      if (!key) return void invalidRequest(res);

      const verified = await auth.api.verifyApiKey({ body: { key, permissions } });
      if (!verified.valid || !verified.key) {
        const code = verified.error?.code;
        if (typeof code === 'string' && KEY_REFUSAL_CODES.includes(code)) {
          alerts.keyRefused(code as KeyRefusalCode);
        }
        // An outage reads as INVALID_API_KEY; it must be a 500, not a refusal.
        await checkApiKeyRelation();
        return refuse(res);
      }

      // Only after the plugin accepts: no state of the service user makes a refused key valid.
      const owner = await serviceUsers.findServiceUser(db, SERVICE);
      if (owner.kind !== 'one') {
        alerts.serviceUserUnresolvable(owner.kind === 'many' ? owner.ids.length : 0);
        return fail(res, new Error('ansari-mcp service user unresolvable'));
      }
      if (verified.key.referenceId !== owner.user.id) return refuse(res);
      // A key whose stored prefix is not this service's and this environment's
      // (another environment's label, another service's, a hand-made one) is
      // the same refusal (#314 Amendment 3). No legacy prefix is accepted here:
      // the MCP window is closed (second external review, finding 1).
      if (!serviceUsers.isAcceptedKeyPrefix(SERVICE, environment, verified.key.prefix)) return refuse(res);

      const clientId = serviceUsers.clientIdOf(verified.key.metadata);
      if (clientId === null || !isMcpClientId(clientId)) {
        alerts.clientIdInvalid(verified.key.id);
        return refuse(res);
      }
      // Counted only for a key that is served: a wrong owner or a bad client id
      // is a refusal, already counted by refuse() (security architect, #314).
      alerts.keyVerified(verified.key);
      res.status(200).json({ valid: true, client_id: clientId, key_id: verified.key.id });
    } catch (err) {
      fail(res, err);
    }
  }

  router.post('/', requireJson, express.json({ limit: limits.VERIFY_BODY_LIMIT }), parseFailure, verify);
  // Every other method (OPTIONS included) and every sub-path ends here, so
  // nothing falls through to corsFor.
  router.use((_req: Request, res: Response) => {
    res.status(404).end();
  });
  return router;
}
