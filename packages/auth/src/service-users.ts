// Service users and their keys (spec 329). A service (the WhatsApp service,
// later the MCP server) is one auth user with no credential, resolved by its
// `{ providerId: 'service', accountId: <name> }` account row, never by email.
// Only apps/auth's service-keys script creates one; its keys are created and
// changed in process through the api-key plugin, whose HTTP surface is blocked.
//
// Permissions and base key prefixes are fixed here, per service, so the script
// takes no free-form permissions: a key for one service is refused at
// another's route. A key's full prefix adds its environment (keyPrefix).
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from './db';
import { ENVIRONMENTS, type Environment } from '@ansari/types/environment';

import { MCP_KEY_BOUNDS, WHATSAPP_KEY_BOUNDS } from './limits';
import { serviceAddress } from './reserved';
import { account, apikey, users } from './schema';

/** The account provider that marks a service user. Better Auth has no such provider, so no one signs in with it. */
export const SERVICE_PROVIDER_ID = 'service';

/** `users.registered_via` for a service user. */
export const SERVICE_REGISTERED_VIA = 'service';

/**
 * Every service that may hold keys: `whatsapp` for the token exchange (spec
 * 329), `ansari-mcp` for apps/api's `/v2/mcp-complete` through the verify
 * route (#314). Each has its own bounds in limits.ts.
 */
export const SERVICES = {
  whatsapp: { permissions: { whatsapp: ['mint'] }, prefix: 'ansari_wa_', bounds: WHATSAPP_KEY_BOUNDS },
  'ansari-mcp': { permissions: { mcp: ['complete'] }, prefix: 'ansari_mcp_', bounds: MCP_KEY_BOUNDS },
} as const;

export type ServiceName = keyof typeof SERVICES;

export function isServiceName(name: string): name is ServiceName {
  return Object.hasOwn(SERVICES, name);
}

/**
 * A key's prefix names the environment it was issued in (#314, owner
 * 2026-11-12, Amendments 2 and 3): `ansari_<service>_<environment>_`, e.g.
 * `ansari_wa_production_`, `ansari_mcp_staging_`, where the environment is the
 * issuing apps/auth's ENVIRONMENT (one vocabulary with apps/api, the frontend
 * and Sentry). The script reads it from its process env; each route accepts
 * only its own environment's prefix, so a key leaked from one environment is
 * readable as such and refused in another.
 */
export function keyPrefix(service: ServiceName, environment: Environment): string {
  return `${SERVICES[service].prefix}${environment}_`;
}

/**
 * Keys issued before #314 carry the bare service prefix (`ansari_wa_`, no
 * environment): at least one live staging WhatsApp key does. While this is
 * true the routes still accept that prefix, the secret-scanning patterns
 * still catch it and the script still refuses it pasted into a flag. The
 * compatibility window closes when `list` shows no live unlabelled key on any
 * database: set this to false and re-register the scanning patterns (the
 * runbook's "Rotate legacy keys" step and its follow-up issue).
 */
export const LEGACY_UNLABELLED_KEYS = true;

/**
 * The prefixes a route of `service` running as `environment` accepts: that
 * environment's, plus the legacy unlabelled prefixes (LEGACY_PREFIXES) while
 * LEGACY_UNLABELLED_KEYS holds. Any other stored prefix (another environment's, another service's, a
 * hand-made one) is the route's ordinary refusal.
 */
export function acceptedKeyPrefixes(service: ServiceName, environment: Environment): readonly string[] {
  const own = keyPrefix(service, environment);
  return LEGACY_UNLABELLED_KEYS ? [own, ...LEGACY_PREFIXES[service]] : [own];
}

/**
 * The unlabelled prefixes keys were issued with before #314, per service: the
 * bare base prefix, and for WhatsApp also `wa_`, the prefix before the
 * 2026-10-30 rename (the runbook's "prefix change"), since a live `wa_` key
 * cannot be ruled out. Accepted only while LEGACY_UNLABELLED_KEYS holds.
 */
export const LEGACY_PREFIXES: Readonly<Record<ServiceName, readonly string[]>> = {
  whatsapp: ['ansari_wa_', 'wa_'],
  'ansari-mcp': ['ansari_mcp_'],
};

/** True when a verified key's stored prefix is one `service`'s route in `environment` accepts. */
export function isAcceptedKeyPrefix(service: ServiceName, environment: Environment, prefix: unknown): boolean {
  return typeof prefix === 'string' && acceptedKeyPrefixes(service, environment).includes(prefix);
}

/** The plugin's key body: 64 letters (its default length and alphabet). */
const KEY_BODY = '[A-Za-z]{64}';

function scanningPattern(service: ServiceName): RegExp {
  const envs = `(?:${ENVIRONMENTS.join('|')})_`;
  return new RegExp(`${SERVICES[service].prefix}${LEGACY_UNLABELLED_KEYS ? `(?:${envs})?` : envs}${KEY_BODY}`);
}

/**
 * GitHub custom secret-scanning patterns, one per service, derived from the
 * same table as keyPrefix: the base prefix, any ENVIRONMENT segment (optional
 * while LEGACY_UNLABELLED_KEYS holds), and the plugin's 64-letter key. The
 * script's pasted-key refusal uses these too, so the three never disagree. The
 * runbook asks the owner to register exactly these (`.source`) for the
 * organisation.
 */
export const SECRET_SCANNING_PATTERNS: Readonly<Record<ServiceName, RegExp>> = {
  whatsapp: scanningPattern('whatsapp'),
  'ansari-mcp': scanningPattern('ansari-mcp'),
};

export type ServiceUser = { id: string; email: string; createdAt: Date };

export type ServiceUserLookup =
  | { kind: 'none' }
  | { kind: 'one'; user: ServiceUser }
  /** `unique(provider_id, account_id)` forbids this; reported, never acted on. */
  | { kind: 'many'; ids: string[] };

/** The service's user, by its `service` account row. */
export async function findServiceUser(db: Db, name: ServiceName): Promise<ServiceUserLookup> {
  const rows = await db
    .select({ id: users.id, email: users.email, createdAt: users.createdAt })
    .from(account)
    .innerJoin(users, eq(users.id, account.userId))
    .where(and(eq(account.providerId, SERVICE_PROVIDER_ID), eq(account.accountId, name)))
    .orderBy(asc(users.createdAt));
  const [first] = rows;
  if (!first) return { kind: 'none' };
  if (rows.length > 1) return { kind: 'many', ids: rows.map((r) => r.id) };
  return { kind: 'one', user: first };
}

/**
 * Create the service's user (no credential, role `user`) and its `service`
 * account row in one transaction: a failure leaves neither. A second user for
 * the same name fails on the address and on `unique(provider_id, account_id)`.
 */
export async function createServiceUser(db: Db, name: ServiceName): Promise<ServiceUser> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        name: `service-${name}`,
        email: serviceAddress(name),
        role: 'user',
        registeredVia: SERVICE_REGISTERED_VIA,
      })
      .returning({ id: users.id, email: users.email, createdAt: users.createdAt });
    if (!user) throw new Error('service user insert returned no row');
    await tx.insert(account).values({
      providerId: SERVICE_PROVIDER_ID,
      accountId: name,
      userId: user.id,
    });
    return user;
  });
}

/** A key as the script shows it: every column except the hash. */
export type ServiceKey = {
  id: string;
  name: string | null;
  prefix: string | null;
  permissions: string | null;
  enabled: boolean | null;
  rateLimitMax: number | null;
  rateLimitTimeWindow: number | null;
  remaining: number | null;
  refillAmount: number | null;
  refillInterval: number | null;
  /** The plugin's metadata as stored: JSON text holding `clientId` (read it with clientIdOf). */
  metadata: string | null;
  createdAt: Date;
  lastRequest: Date | null;
};

const keyColumns = {
  id: apikey.id,
  name: apikey.name,
  prefix: apikey.prefix,
  permissions: apikey.permissions,
  enabled: apikey.enabled,
  rateLimitMax: apikey.rateLimitMax,
  rateLimitTimeWindow: apikey.rateLimitTimeWindow,
  remaining: apikey.remaining,
  refillAmount: apikey.refillAmount,
  refillInterval: apikey.refillInterval,
  metadata: apikey.metadata,
  createdAt: apikey.createdAt,
  lastRequest: apikey.lastRequest,
};

/** Every key the service user owns, oldest first. The hash is never read. */
export async function listServiceKeys(db: Db, userId: string): Promise<ServiceKey[]> {
  return db
    .select(keyColumns)
    .from(apikey)
    .where(eq(apikey.referenceId, userId))
    .orderBy(asc(apikey.createdAt), asc(apikey.id));
}

/**
 * The `clientId` a key's metadata carries, or null when there is none or it is
 * not a string. The plugin has handed metadata back both as the stored JSON
 * text (1.7.7) and as a parsed object (1.7.20), so both are read; malformed
 * text is null, never a throw. The value is returned as stored: callers apply
 * their own rule (isMcpClientId for `ansari-mcp`).
 */
export function clientIdOf(metadata: unknown): string | null {
  let value = metadata;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const clientId = (value as Record<string, unknown>).clientId;
  return typeof clientId === 'string' ? clientId : null;
}
