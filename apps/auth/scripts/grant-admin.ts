/**
 * Admin role script (spec 300; moved from apps/api/scripts/grant-admin.ts,
 * same name). Admin is `auth.users.role = 'admin'`, and the admin plugin's
 * HTTP surface is blocked, so this script is the only way to grant or revoke
 * it. It runs against the AUTH database (`DATABASE_URL` in apps/auth's env),
 * never sets a password, and never touches the app database.
 *
 * Usage (from apps/auth/):
 *   pnpm exec tsx scripts/grant-admin.ts <email>                    show the account; grants nothing
 *   pnpm exec tsx scripts/grant-admin.ts <email> --confirm <id>     grant admin to exactly that account
 *   pnpm exec tsx scripts/grant-admin.ts --revoke <email>           back to role 'user'
 *   pnpm exec tsx scripts/grant-admin.ts --list                     every admin, for the audit
 *
 * Granting is two steps. apps/auth sends no verification email, so whoever
 * registered an address owns that account without proving the inbox: the first
 * step shows the account (id, name, created_at) so the operator can check it is
 * the person they mean, and only `--confirm <that id>` grants. An id that is not
 * the account the email resolves to grants nothing; the show step exits 2, so
 * a script that forgets --confirm stops. It warns on a recent or unverified
 * account (the squat signatures), never creates one, and refuses the system
 * domain. A demotion takes effect at
 * once: apps/api asks for the role on each admin request.
 */
import 'dotenv/config';
import { createDb, isSystemAddress, normalizeEmail, users, type Db } from '@ansari/auth';

export type GrantAdminCommand =
  | { kind: 'show'; email: string }
  | { kind: 'grant'; email: string; confirmId: string }
  | { kind: 'revoke'; email: string }
  | { kind: 'list' };

export const USAGE = [
  'Usage: pnpm exec tsx scripts/grant-admin.ts <email>',
  '       pnpm exec tsx scripts/grant-admin.ts <email> --confirm <account id>',
  '       pnpm exec tsx scripts/grant-admin.ts --revoke <email>',
  '       pnpm exec tsx scripts/grant-admin.ts --list',
].join('\n');

const isValue = (arg: string | undefined): arg is string => !!arg && !arg.startsWith('--');

export function parseArgs(argv: readonly string[]): GrantAdminCommand | null {
  const [first, second, third, ...rest] = argv;
  if (rest.length > 0) return null;
  if (first === '--list') return second === undefined ? { kind: 'list' } : null;
  if (first === '--revoke') return isValue(second) && third === undefined ? { kind: 'revoke', email: second } : null;
  if (!isValue(first)) return null;
  if (second === undefined) return { kind: 'show', email: first };
  if (second === '--confirm' && isValue(third)) return { kind: 'grant', email: first, confirmId: third };
  return null;
}

/** The account was not the one the operator confirmed: nothing is granted. */
export class ConfirmMismatchError extends Error {
  constructor() {
    super('The --confirm id is not the account this email belongs to. Nothing was granted. Run without --confirm to see it.');
    this.name = 'ConfirmMismatchError';
  }
}

/** System accounts live only in the app database and never hold a role. */
export class SystemAddressError extends Error {
  constructor() {
    super('A system-domain address is never an auth account and is never granted admin.');
    this.name = 'SystemAddressError';
  }
}

/** An account younger than this is flagged: a squatted address is usually a fresh sign-up. */
export const RECENT_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

export type GrantAdminResult = { lines: string[]; exitCode: number };

/**
 * The squat signatures (security review): a recent sign-up, or an address
 * nobody has verified. Copied legacy accounts are verified and old; a new
 * admin who signed up after the cutover is unverified, so the warning there
 * asks the operator to confirm the person out of band.
 */
function squatWarnings(user: users.UserRecord, now: Date): string[] {
  const warnings: string[] = [];
  if (now.getTime() - user.createdAt.getTime() < RECENT_ACCOUNT_MS) {
    warnings.push('WARNING: this account was created less than 7 days ago.');
  }
  if (!user.emailVerified) {
    warnings.push('WARNING: this address is NOT verified; anyone could have registered it.');
  }
  if (warnings.length > 0) {
    warnings.push('Confirm with the person, out of band, that this account is theirs before --confirm.');
  }
  return warnings;
}

/** Runs one command and returns the lines to print and the exit code. */
export async function runGrantAdmin(
  db: Db,
  command: GrantAdminCommand,
  now: Date = new Date()
): Promise<GrantAdminResult> {
  if (command.kind === 'list') {
    const admins = await users.listAdmins(db);
    return {
      lines: [`${admins.length} admin(s):`, ...admins.map((a) => `  ${a.email}  ${a.id}`)],
      exitCode: 0,
    };
  }
  const email = normalizeEmail(command.email);
  if (command.kind === 'revoke') {
    await users.setRoleByEmail(db, email, users.USER_ROLE);
    return { lines: [`Revoked admin from ${email} (role=user).`], exitCode: 0 };
  }
  if (isSystemAddress(email)) throw new SystemAddressError();
  const user = await users.findUserByEmail(db, email);
  if (!user) throw new users.UserNotFoundError();
  const warnings = squatWarnings(user, now);
  if (command.kind === 'show') {
    return {
      lines: [
        `Account for ${email}:`,
        `  id              ${user.id}`,
        `  email           ${user.email}`,
        `  created_at      ${user.createdAt.toISOString()}`,
        `  email_verified  ${user.emailVerified}`,
        `  role            ${user.role ?? users.USER_ROLE}`,
        ...warnings,
        'Nothing was granted. If this is the person you mean, run:',
        `  pnpm exec tsx scripts/grant-admin.ts ${email} --confirm ${user.id}`,
      ],
      // Not a success: nothing was granted, so a script that forgets --confirm stops here.
      exitCode: 2,
    };
  }
  if (command.confirmId !== user.id) throw new ConfirmMismatchError();
  await users.setRoleByEmail(db, email, users.ADMIN_ROLE);
  return {
    lines: [...warnings, `Granted admin to ${email} (${user.id}, role=admin). No password was changed.`],
    exitCode: 0,
  };
}

/** A missing user is reported plainly; anything else by its name (no driver detail). */
export function scriptError(err: unknown): string {
  if (
    err instanceof users.UserNotFoundError ||
    err instanceof ConfirmMismatchError ||
    err instanceof SystemAddressError
  ) {
    return err.message;
  }
  return err instanceof Error ? err.name : 'unknown';
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (!command) {
    console.error(USAGE);
    process.exit(1);
  }
  const { lines, exitCode } = await runGrantAdmin(createDb(), command);
  for (const line of lines) console.log(line);
  process.exit(exitCode);
}

if (process.argv[1]?.endsWith('grant-admin.ts')) {
  main().catch((err: unknown) => {
    console.error('grant-admin failed:', scriptError(err));
    process.exit(1);
  });
}
