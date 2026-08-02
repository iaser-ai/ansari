/**
 * Admin bootstrap script (spec 4) — the ONLY path to create the first admin,
 * since public registration of admin addresses is refused and the startup
 * assertion fails the boot without them.
 *
 *   Deploy runbook ordering: apply migration → run THIS script → deploy.
 *
 * Usage (from backend/):
 *   GRANT_ADMIN_PASSWORD='<strong-password>' npx tsx scripts/grant-admin.ts <email>
 *   # or omit the env var and you'll be prompted (input is read from stdin).
 *
 * The password is taken from an env var or an interactive prompt — NEVER a
 * positional CLI arg, which would leak into shell history / the process table.
 *
 * Idempotent: if the account already exists it is flagged is_admin (its password
 * is left untouched); otherwise it is created with a bcrypt hash and is_admin=true.
 */
import { createInterface } from 'readline';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { findUserByEmail } from '../lib/db/users';
import { hashPassword } from '../lib/auth/password';
import { users } from '../db/schema';

const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Create-or-flag an admin account. Returns whether a new row was created.
 * When the account already exists, only `is_admin` is set (password unchanged),
 * so `password` may be omitted in that case.
 */
export async function grantAdmin(
  email: string,
  password?: string
): Promise<{ created: boolean }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('email is required');

  const existing = await findUserByEmail(normalized);
  if (existing) {
    if (!existing.isAdmin) {
      await db
        .update(users)
        .set({ isAdmin: true, updatedAt: new Date() })
        .where(eq(users.id, existing.id));
    }
    return { created: false };
  }

  if (!password || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `a password of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters is required to create a new admin account`
    );
  }

  const passwordHash = await hashPassword(password);
  await db.insert(users).values({
    email: normalized,
    passwordHash,
    isAdmin: true,
    source: 'web',
  });
  return { created: true };
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npx tsx scripts/grant-admin.ts <email>');
    console.error("Provide the password via GRANT_ADMIN_PASSWORD or the interactive prompt.");
    process.exit(1);
  }

  let password = process.env.GRANT_ADMIN_PASSWORD;
  if (!password) {
    password = await prompt(`Password for admin ${email} (min ${MIN_ADMIN_PASSWORD_LENGTH} chars, only used if the account is new): `);
  }

  const { created } = await grantAdmin(email, password);
  console.log(
    created
      ? `Created admin account ${email.toLowerCase()} (is_admin=true).`
      : `Flagged existing account ${email.toLowerCase()} as admin (is_admin=true).`
  );
  process.exit(0);
}

// Only run the CLI when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('grant-admin.ts')) {
  main().catch((err) => {
    console.error('grant-admin failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
