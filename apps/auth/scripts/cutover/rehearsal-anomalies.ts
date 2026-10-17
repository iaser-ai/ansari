/**
 * Phase 13 rehearsal, STAGING ONLY: seeds the staging APP database with one
 * row per anomaly class the preflight checks, so the copy's guards are shown
 * to fire in the real environment (real psql, real Postgres), not only in the
 * pglite interpreter. The existing staging users and system rows stay.
 *
 * It prints SQL for psql to read on a pipe; the bcrypt hashes in it never
 * touch a file or a terminal:
 *
 *   ANSARI_CUTOVER_ENV=staging ./node_modules/.bin/tsx scripts/cutover/rehearsal-anomalies.ts seed \
 *     | psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction
 *
 * (REHEARSAL_PASSWORD, APP_DATABASE_URL and PROMOTED_COMMIT are already in the
 * session, entered with `read -rs`.)
 *
 * Commands, in the rehearsal's order (docs/cutover/rehearsal.md):
 *   seed               the eight rows below (refuses if any is already there)
 *   resolve-collision  delete the collision pair (the copy then stops on the non-bcrypt hash)
 *   resolve-hash       delete the non-bcrypt row (the copy then stops on the NULL timestamp)
 *   resolve-null       set the NULL updated_at to its created_at (the copy then passes)
 *   remove             delete every rehearsal row (threads etc. go with the cascade)
 *
 * Runs on the owner's machine over the Tailscale route (spec 300 amendment
 * H-8), from the promoted commit's clean checkout, against STAGING only. A
 * Railway-internal host name is the same in both environments, so nothing in
 * the URL says which one it is: the operator types ANSARI_CUTOVER_ENV=staging,
 * and anything else is refused (an owner-accepted residual: a typed word, not
 * a check the environment can prove).
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// apps/auth depends on bcrypt but not on its type package (the library code
// that uses it lives in packages/auth); these are the two calls this script makes.
const bcrypt = createRequire(import.meta.url)('bcrypt') as {
  genSalt(rounds: number, minor: 'a' | 'b'): Promise<string>;
  hash(data: string, salt: string): Promise<string>;
};

/** A Railway-internal host, as operator-env.sh allows: `<name>.railway.internal`, a trailing dot allowed. */
const INTERNAL_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.railway\.internal\.?$/;

/** The host of a postgres URL, lower-cased, or null when it does not parse. */
export function urlHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function isInternalHost(host: string | null): boolean {
  return host !== null && INTERNAL_HOST.test(host);
}

/** Every rehearsal row's id starts with this, so `remove` touches nothing else. */
export const ID_PREFIX = 'e0300000-0000-4000-8000-';
const rid = (n: number) => `${ID_PREFIX}${String(n).padStart(12, '0')}`;

export const ROWS = {
  collisionA: { id: rid(1), email: 'Rehearsal.Collide@example.com' },
  collisionB: { id: rid(2), email: 'rehearsal.collide@example.com' },
  nullUpdatedAt: { id: rid(3), email: 'rehearsal.null@example.com' },
  mixedCase2a: { id: rid(4), email: 'Rehearsal.Mixed@Example.com' },
  plain2b: { id: rid(5), email: 'rehearsal.2b@example.com' },
  legacyAdmin: { id: rid(6), email: 'rehearsal.admin@example.com' },
  guest: { id: rid(7), email: 'guest_rhrsl00001@askansari.ai' },
  notBcrypt: { id: rid(8), email: 'rehearsal.scrypt@example.com' },
} as const;

/** An scrypt-shaped hash (salt:key, hex), as no legacy row should hold: the copy refuses it. */
export const NOT_BCRYPT_HASH = `${'ab'.repeat(16)}:${'cd'.repeat(64)}`;

export type Command = 'seed' | 'resolve-collision' | 'resolve-hash' | 'resolve-null' | 'remove';
const COMMANDS: readonly Command[] = ['seed', 'resolve-collision', 'resolve-hash', 'resolve-null', 'remove'];

export const MIN_PASSWORD_LENGTH = 12;

/** Why this run must not go ahead, or null. Checked before anything is generated. */
export function refusal(input: {
  cutoverEnv: string | undefined;
  appHost: string | null;
  checkout: 'ok' | 'dirty' | 'not-promoted' | 'no-commit' | 'no-git';
  stdoutIsTTY: boolean;
  command: string | undefined;
  password: string | undefined;
}): string | null {
  if (input.cutoverEnv !== 'staging')
    return `refusing to run against anything but staging (ANSARI_CUTOVER_ENV is ${input.cutoverEnv ? `'${input.cutoverEnv}'` : 'unset'}; type ANSARI_CUTOVER_ENV=staging)`;
  if (input.appHost === null) return 'APP_DATABASE_URL is unset or not a URL';
  if (input.appHost.endsWith('.proxy.rlwy.net'))
    return "APP_DATABASE_URL points at Railway's public TCP proxy; use the <name>.railway.internal host over the Tailscale route";
  if (!isInternalHost(input.appHost))
    return "APP_DATABASE_URL's host is not Railway-internal (<name>.railway.internal over the Tailscale route)";
  if (input.checkout === 'no-git') return 'not inside a git checkout';
  if (input.checkout === 'no-commit') return 'PROMOTED_COMMIT is unset (the commit the window recorded)';
  if (input.checkout === 'dirty') return 'the checkout has uncommitted changes';
  if (input.checkout === 'not-promoted') return 'HEAD is not PROMOTED_COMMIT';
  if (!input.command || !(COMMANDS as readonly string[]).includes(input.command))
    return `usage: rehearsal-anomalies.ts <${COMMANDS.join('|')}> | psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction`;
  if (input.stdoutIsTTY) return 'refusing to print to a terminal: pipe the output into psql';
  if (input.command === 'seed' && (input.password ?? '').length < MIN_PASSWORD_LENGTH)
    return `seed needs REHEARSAL_PASSWORD of at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

export type Hashes = { h2a: string; h2b: string };

/** bcrypt hashes in both legacy prefixes; cost 12 is the legacy service's. */
export async function makeHashes(password: string, rounds = 12): Promise<Hashes> {
  const h2a = await bcrypt.hash(password, await bcrypt.genSalt(rounds, 'a'));
  const h2b = await bcrypt.hash(password, await bcrypt.genSalt(rounds, 'b'));
  return { h2a, h2b };
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The SQL for one command. Every row is addressed by its rehearsal id. */
export function anomalySql(command: Command, hashes?: Hashes): string {
  const ids = Object.values(ROWS).map((r) => quote(r.id)).join(', ');
  switch (command) {
    case 'seed': {
      if (!hashes) throw new Error('seed needs hashes');
      const { h2a, h2b } = hashes;
      const r = ROWS;
      return `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE id::text LIKE ${quote(`${ID_PREFIX}%`)}) THEN
    RAISE EXCEPTION 'rehearsal: rehearsal rows already exist; run remove first';
  END IF;
END $$;
INSERT INTO public.users (id, email, password_hash, first_name, last_name, created_at, updated_at, is_admin) VALUES
  (${quote(r.collisionA.id)}, ${quote(r.collisionA.email)}, ${quote(h2b)}, 'Rehearsal', 'CollideA', now() - interval '3 days', now(), false),
  (${quote(r.collisionB.id)}, ${quote(r.collisionB.email)}, ${quote(h2b)}, 'Rehearsal', 'CollideB', now() - interval '2 days', now(), false),
  (${quote(r.nullUpdatedAt.id)}, ${quote(r.nullUpdatedAt.email)}, ${quote(h2b)}, 'Rehearsal', 'Null', now() - interval '2 days', NULL, false),
  (${quote(r.mixedCase2a.id)}, ${quote(r.mixedCase2a.email)}, ${quote(h2a)}, 'Rehearsal', 'Mixed', now() - interval '1 day', now(), false),
  (${quote(r.plain2b.id)}, ${quote(r.plain2b.email)}, ${quote(h2b)}, NULL, NULL, now() - interval '1 day', now(), false),
  (${quote(r.legacyAdmin.id)}, ${quote(r.legacyAdmin.email)}, ${quote(h2b)}, 'Rehearsal', 'Admin', now() - interval '1 day', now(), true),
  (${quote(r.guest.id)}, ${quote(r.guest.email)}, ${quote(h2b)}, 'Welcome', 'Guest', now() - interval '1 day', now(), false),
  (${quote(r.notBcrypt.id)}, ${quote(r.notBcrypt.email)}, ${quote(NOT_BCRYPT_HASH)}, 'Rehearsal', 'Scrypt', now() - interval '1 day', now(), false);
`;
    }
    case 'resolve-collision':
      return `DELETE FROM public.users WHERE id IN (${quote(ROWS.collisionA.id)}, ${quote(ROWS.collisionB.id)});\n`;
    case 'resolve-hash':
      return `DELETE FROM public.users WHERE id = ${quote(ROWS.notBcrypt.id)};\n`;
    case 'resolve-null':
      return `UPDATE public.users SET updated_at = created_at WHERE id = ${quote(ROWS.nullUpdatedAt.id)} AND updated_at IS NULL;\n`;
    case 'remove':
      return `DELETE FROM public.users WHERE id IN (${ids});\n`;
  }
}

/** The checkout this runs from must be clean and at PROMOTED_COMMIT, as operator-env.sh checks. */
export function checkoutState(promoted: string | undefined, cwd: string): 'ok' | 'dirty' | 'not-promoted' | 'no-commit' | 'no-git' {
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  try {
    git('rev-parse', '--show-toplevel');
  } catch {
    return 'no-git';
  }
  if (!promoted) return 'no-commit';
  if (git('status', '--porcelain') !== '') return 'dirty';
  let wanted = '';
  try {
    wanted = git('rev-parse', '--verify', '--quiet', `${promoted}^{commit}`);
  } catch {
    return 'not-promoted';
  }
  return git('rev-parse', 'HEAD') === wanted ? 'ok' : 'not-promoted';
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const password = process.env.REHEARSAL_PASSWORD;
  const refused = refusal({
    cutoverEnv: process.env.ANSARI_CUTOVER_ENV,
    appHost: urlHost(process.env.APP_DATABASE_URL),
    checkout: checkoutState(process.env.PROMOTED_COMMIT, import.meta.dirname),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    command,
    password,
  });
  if (refused) {
    console.error(`rehearsal-anomalies: ${refused}`);
    process.exit(2);
  }
  const cmd = command as Command;
  const hashes = cmd === 'seed' ? await makeHashes(password as string) : undefined;
  process.stdout.write(anomalySql(cmd, hashes));
}

if (process.argv[1]?.endsWith('rehearsal-anomalies.ts')) {
  main().catch((err: unknown) => {
    console.error('rehearsal-anomalies failed:', err instanceof Error ? err.name : 'unknown');
    process.exit(1);
  });
}
