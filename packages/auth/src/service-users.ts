// Service users and their keys (spec 329). A service (the WhatsApp service,
// later the MCP server) is one auth user with no credential, resolved by its
// `{ providerId: 'service', accountId: <name> }` account row, never by email.
// Only apps/auth's service-keys script creates one; its keys are created and
// changed in process through the api-key plugin, whose HTTP surface is blocked.
//
// Permissions and key prefixes are fixed here, per service, so the script
// takes no free-form permissions: a key for one service is refused at
// another's route.
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from './db';
import { WHATSAPP_KEY_BOUNDS } from './limits';
import { serviceAddress } from './reserved';
import { account, apikey, users } from './schema';

/** The account provider that marks a service user. Better Auth has no such provider, so no one signs in with it. */
export const SERVICE_PROVIDER_ID = 'service';

/** `users.registered_via` for a service user. */
export const SERVICE_REGISTERED_VIA = 'service';

/**
 * Every service that may hold keys. `ansari-mcp` is reserved for #314: it has
 * no route yet, and its limits borrow the WhatsApp bounds until #314 sizes
 * its own.
 */
export const SERVICES = {
  whatsapp: { permissions: { whatsapp: ['mint'] }, prefix: 'ansari_wa_', bounds: WHATSAPP_KEY_BOUNDS },
  'ansari-mcp': { permissions: { mcp: ['complete'] }, prefix: 'ansari_mcp_', bounds: WHATSAPP_KEY_BOUNDS },
} as const;

export type ServiceName = keyof typeof SERVICES;

export function isServiceName(name: string): name is ServiceName {
  return Object.hasOwn(SERVICES, name);
}

/**
 * GitHub custom secret-scanning patterns, one per key prefix: the prefix and
 * the plugin's 64-letter key. The runbook asks the owner to register exactly
 * these (`.source`) for the organisation.
 */
export const SECRET_SCANNING_PATTERNS: Readonly<Record<ServiceName, RegExp>> = {
  whatsapp: /ansari_wa_[A-Za-z]{64}/,
  'ansari-mcp': /ansari_mcp_[A-Za-z]{64}/,
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
