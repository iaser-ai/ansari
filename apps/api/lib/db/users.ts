import { eq, sql } from 'drizzle-orm';
import { db, type Executor } from './index';
import { users, type User } from '@/db/schema';
import { SYSTEM_ACCOUNTS, type SystemKey } from '@/lib/auth/system-accounts';

// User operations. Credentials, sessions and roles live in apps/auth's
// database (spec 300); the app row carries identity and attribution only.

/**
 * Resolve a system account by its durable `system_key` (spec 4) — never by email.
 * Returns undefined if no row carries that key (a pre-registered look-alike, which
 * has `system_key = NULL`, is therefore never resolved as a system account).
 */
export async function findSystemUser(systemKey: SystemKey): Promise<User | undefined> {
  const result = await db.select().from(users).where(eq(users.systemKey, systemKey)).limit(1);
  return result[0];
}

/**
 * Resolve, or lazily provision, the system account for `systemKey`. The created
 * row is identified by `system_key` (unregisterable) and has no credential:
 * apps/auth holds no account for it, so it can never be logged into.
 *
 * If the canonical system email is already held by a NON-system account
 * (pre-registration / hijack — the vulnerability spec 4 closes), provisioning
 * fails fast with an operator-actionable error rather than misrouting system data
 * or looping. The migration's inspect-before-apply step prevents this in practice.
 */
/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505). Walks the
 * `.cause` chain because drizzle wraps the driver error (the pg/pglite error,
 * which carries `code`, is nested under `.cause`).
 */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function getOrCreateSystemUser(systemKey: SystemKey): Promise<User> {
  const existing = await findSystemUser(systemKey);
  if (existing) return existing;

  const account = SYSTEM_ACCOUNTS[systemKey];
  try {
    const result = await db
      .insert(users)
      .values({
        email: account.email,
        firstName: account.firstName,
        lastName: account.lastName,
        source: systemKey,
        systemKey,
      })
      .returning();
    return result[0];
  } catch (err) {
    // Only a unique-constraint violation is an expected, interpretable failure
    // here. Anything else (DB outage, permission, schema error) must propagate
    // unchanged rather than be misreported as an occupied system email.
    if (!isUniqueViolation(err)) throw err;

    // A unique violation is one of two cases:
    //  - system_key race: a concurrent request created the row first → re-read by key.
    const raced = await findSystemUser(systemKey);
    if (raced) return raced;
    //  - the email is held by a non-system row (hijack): cannot proceed safely.
    throw new Error(
      `System account '${systemKey}' cannot be provisioned: its address is already held by a ` +
        `non-system account. Remediate the occupying row before deploy (migration inspect-before-apply step).`
    );
  }
}

export async function findUserById(id: string): Promise<User | undefined> {
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

/**
 * The app row of a user apps/auth created (spec 300): the same id, the email
 * normalized, the names and `registered_via` copied once. `password_hash`
 * stays NULL, because the credential lives in the auth database (0011 drops
 * its NOT NULL). `ON CONFLICT (id) DO NOTHING`, so concurrent creators make
 * one row; an email another row holds raises the unique violation.
 */
export async function insertAppUserRow(
  row: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    registeredVia: string | null;
  },
  exec: Executor = db
): Promise<void> {
  await exec.execute(sql`
    INSERT INTO ${users} (id, email, first_name, last_name, registered_via)
    VALUES (${row.id}, ${row.email.trim().toLowerCase()}, ${row.firstName}, ${row.lastName}, ${row.registeredVia})
    ON CONFLICT (id) DO NOTHING
  `);
}
