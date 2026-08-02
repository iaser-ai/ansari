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
 * A password is ALWAYS required and is SET on the account (created or promoted).
 * Resetting the password on promotion is deliberate and security-critical: if the
 * address was pre-registered by an attacker — the exact vulnerability spec 4
 * closes — flagging it admin while preserving their password would hand them
 * admin. Overwriting the credential with the operator's password locks them out
 * and guarantees the admin account is login-capable.
 */
import { createInterface } from 'readline';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { findUserByEmail, deleteUserTokens } from '../lib/db/users';
import { hashPassword } from '../lib/auth/password';
import { users } from '../db/schema';

const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Create-or-promote an admin account, always SETTING the supplied password.
 * Returns whether a new row was created (false = an existing row was promoted).
 * A password is required in BOTH cases (see the security note above).
 */
export async function grantAdmin(
  email: string,
  password?: string
): Promise<{ created: boolean }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('email is required');

  if (!password || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `a password of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters is required (it is set on the admin account)`
    );
  }

  const passwordHash = await hashPassword(password);
  const existing = await findUserByEmail(normalized);
  if (existing) {
    // Promote AND reset the password to the operator-supplied value — never
    // preserve a possibly attacker-controlled credential (spec 4).
    await db
      .update(users)
      .set({ isAdmin: true, passwordHash, updatedAt: new Date() })
      .where(eq(users.id, existing.id));
    // Revoke ALL of the account's existing tokens. Resetting the password alone
    // does NOT invalidate already-issued access/refresh tokens: a pre-registrant's
    // 90-day refresh token would otherwise survive promotion and resolve to this
    // now-admin row. (Same precedent as reset_password's deleteUserTokens.)
    await deleteUserTokens(existing.id);
    return { created: false };
  }

  await db.insert(users).values({
    email: normalized,
    passwordHash,
    isAdmin: true,
    source: 'web',
  });
  return { created: true };
}

function prompt(question: string): Promise<string> {
  // Note: input echoes to the terminal (no silent-input mode). Acceptable for an
  // operator-run, one-off bootstrap; it never lands in shell history (unlike a CLI
  // arg). Prefer GRANT_ADMIN_PASSWORD in CI/non-interactive contexts.
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
    password = await prompt(`Password to SET for admin ${email} (min ${MIN_ADMIN_PASSWORD_LENGTH} chars): `);
  }

  const { created } = await grantAdmin(email, password);
  console.log(
    created
      ? `Created admin account ${email.toLowerCase()} (is_admin=true, password set).`
      : `Promoted existing account ${email.toLowerCase()} to admin (is_admin=true, password reset).`
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
