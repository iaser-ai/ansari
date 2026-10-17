/**
 * Ban script (spec 300, plan phase 5). The admin plugin's HTTP surface is
 * blocked, so a ban is an operator action, like a role. It runs against the
 * AUTH database (`DATABASE_URL` in apps/auth's env).
 *
 * Usage (from apps/auth/):
 *   pnpm exec tsx scripts/ban-user.ts --ban <email> [--reason <text>] [--days <n>]
 *   pnpm exec tsx scripts/ban-user.ts --unban <email>
 *
 * A ban sets `banned`, `ban_reason` and `ban_expires` (none: permanent) and
 * deletes every session of the user in the same transaction. Sign-in is then
 * refused by the admin plugin, and the account endpoint stops answering for
 * the user's tokens (their sessions are gone), so apps/api's admin routes
 * refuse at once. JWTs already issued
 * stay valid until their `exp` (15 minutes) elsewhere: the accepted window.
 */
import 'dotenv/config';
import { createDb, normalizeEmail, users, type Db } from '@ansari/auth';

const DAY_MS = 24 * 60 * 60 * 1000;

export type BanCommand =
  | { kind: 'ban'; email: string; reason: string | null; days: number | null }
  | { kind: 'unban'; email: string };

export const USAGE = [
  'Usage: pnpm exec tsx scripts/ban-user.ts --ban <email> [--reason <text>] [--days <n>]',
  '       pnpm exec tsx scripts/ban-user.ts --unban <email>',
].join('\n');

const isValue = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0 && !value.startsWith('--');

export function parseArgs(argv: readonly string[]): BanCommand | null {
  const [action, email, ...rest] = argv;
  if (!isValue(email)) return null;
  if (action === '--unban') return rest.length === 0 ? { kind: 'unban', email } : null;
  if (action !== '--ban') return null;

  let reason: string | null = null;
  let days: number | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!isValue(value)) return null;
    if (flag === '--reason' && reason === null) reason = value;
    else if (flag === '--days' && days === null) {
      days = Number(value);
      if (!Number.isInteger(days) || days < 1) return null;
    } else return null;
  }
  return { kind: 'ban', email, reason, days };
}

/** Runs one command and returns the lines to print. */
export async function runBanUser(db: Db, command: BanCommand, now = Date.now()): Promise<string[]> {
  const email = normalizeEmail(command.email);
  if (command.kind === 'unban') {
    await users.unbanUserByEmail(db, email);
    return [`Unbanned ${email}.`];
  }
  const expiresAt = command.days === null ? null : new Date(now + command.days * DAY_MS);
  const sessions = await users.banUserByEmail(db, email, { reason: command.reason, expiresAt });
  const until = expiresAt ? `until ${expiresAt.toISOString()}` : 'permanently';
  return [`Banned ${email} ${until}; deleted ${sessions} session(s).`];
}

/** A missing user is reported plainly; anything else by its name (no driver detail). */
export function scriptError(err: unknown): string {
  if (err instanceof users.UserNotFoundError) return err.message;
  return err instanceof Error ? err.name : 'unknown';
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (!command) {
    console.error(USAGE);
    process.exit(1);
  }
  const lines = await runBanUser(createDb(), command);
  for (const line of lines) console.log(line);
  process.exit(0);
}

if (process.argv[1]?.endsWith('ban-user.ts')) {
  main().catch((err: unknown) => {
    console.error('ban-user failed:', scriptError(err));
    process.exit(1);
  });
}
