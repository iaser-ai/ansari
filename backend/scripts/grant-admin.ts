/**
 * Admin bootstrap script (spec 4) — the ONLY path to create the first admin,
 * since public registration of admin addresses is refused and the startup
 * assertion fails the boot without them.
 *
 *   Deploy runbook ordering: apply migration → run THIS script → deploy.
 *
 * Usage (from backend/):
 *   npx tsx scripts/grant-admin.ts <email>
 *   # You'll be securely prompted for the password (input is hidden, not echoed).
 *
 * The password is read from a hidden interactive prompt — NEVER a positional CLI
 * arg (which would leak into shell history / the process table).
 *
 * A password is ALWAYS required and is SET on the account (created or promoted).
 * Resetting the password on promotion is deliberate and security-critical: if the
 * address was pre-registered by an attacker — the exact vulnerability spec 4
 * closes — flagging it admin while preserving their password would hand them
 * admin. Overwriting the credential with the operator's password locks them out
 * and guarantees the admin account is login-capable.
 */
import { createInterface } from 'readline';
import { eq, sql } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { findUserByEmail } from '../lib/db/users';
import { hashPassword, checkPasswordStrength } from '../lib/auth/password';
import { users, tokens } from '../db/schema';

const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MAX_ADMIN_PASSWORD_LENGTH = 128;

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

  // Enforce the same password policy as the product (spec 4): bounded length and
  // the strength check. An admin credential must not be weaker than a user's.
  if (
    !password ||
    password.length < MIN_ADMIN_PASSWORD_LENGTH ||
    password.length > MAX_ADMIN_PASSWORD_LENGTH
  ) {
    throw new Error(
      `a password of ${MIN_ADMIN_PASSWORD_LENGTH}-${MAX_ADMIN_PASSWORD_LENGTH} characters is required (it is set on the admin account)`
    );
  }
  const strength = checkPasswordStrength(password);
  if (!strength.valid) {
    throw new Error(
      `the admin password is too weak (${strength.suggestions.join(' ')})`.trim()
    );
  }

  const passwordHash = await hashPassword(password);
  const existing = await findUserByEmail(normalized);
  if (existing) {
    // Promote atomically in one transaction so there is no window in which the
    // account is admin-with-live-attacker-tokens (spec 4):
    //   - set is_admin + reset the password (never preserve an attacker credential)
    //   - bump session_version: Phase 7 embeds this in issued tokens and rejects any
    //     with a stale version, so even a token minted by a refresh racing this
    //     promotion is invalidated (forward-compatible; no enforcement until Phase 7)
    //   - delete all existing tokens (immediate revocation of current sessions)
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          isAdmin: true,
          passwordHash,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id));
      await tx.delete(tokens).where(eq(tokens.userId, existing.id));
    });
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

/**
 * Read a line from stdin with the typed characters HIDDEN (no echo) — for
 * passwords. The question is written first, then readline is muted so keystrokes
 * are not shown on screen.
 */
function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Suppress echo of everything after the question is printed.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npx tsx scripts/grant-admin.ts <email>');
    console.error('You will be securely prompted for the password.');
    process.exit(1);
  }

  const password = await promptHidden(
    `Password to SET for admin ${email} (${MIN_ADMIN_PASSWORD_LENGTH}-${MAX_ADMIN_PASSWORD_LENGTH} chars, hidden): `
  );

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
