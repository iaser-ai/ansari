/**
 * Runnable harness for the service-keys script (spec 329, plan phase 4): a
 * throwaway pglite auth database built from packages/auth's journal, every
 * subcommand run in the runbook's order, and each output printed as the
 * operator would see it. The documented output is checked by running this,
 * not by reading it. Nothing leaves the process: Sentry events go to a
 * recorder that prints them. The database URL is the placeholder the test
 * env sets; its user, password and path must not appear below.
 *
 *   pnpm --filter ansari-auth exec tsx scripts/probes/service-keys-demo.ts
 */
import { createAuth, limits } from '@ansari/auth';

import { drizzleFor, migrate, setAuthEnv } from '../../../../packages/auth/tests/helpers/auth-db';
import { serviceKeys, type KeyEvent, type Recorder } from '../service-keys';

const recorder: Recorder = {
  capture(event: KeyEvent) {
    console.log(`  [sentry event] ${JSON.stringify(event)}`);
  },
  flush: async () => true,
};

const initial = limits.WHATSAPP_KEY_INITIAL;
const LIMITS = [
  '--rate-max', String(initial.rateLimitMax),
  '--rate-window', String(initial.rateLimitTimeWindow / 1000),
  '--daily', String(initial.refillAmount),
];

async function main(): Promise<void> {
  setAuthEnv('http://localhost:3100');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('setAuthEnv sets DATABASE_URL');
  const client = await migrate();
  const db = drizzleFor(client);
  const auth = createAuth(db);
  const transcript: string[] = [];

  async function step(argv: string[]): Promise<string[]> {
    console.log(`\n$ tsx scripts/service-keys.ts ${argv.join(' ')}`);
    const { lines, exitCode } = await serviceKeys(argv, {
      databaseUrl,
      connect: () => ({ db, auth }),
      recorder,
      print: (line) => console.log(line),
    });
    console.log(`(exit ${exitCode})`);
    transcript.push(...lines);
    return lines;
  }

  const idIn = (lines: string[], pattern: RegExp) => {
    const id = lines.map((l) => pattern.exec(l)?.[1]).find(Boolean);
    if (!id) throw new Error(`no match for ${pattern} in the output`);
    return id;
  };

  await step(['create-service', 'whatsapp']);
  await step(['create-service', 'whatsapp', '--confirm', 'wrong']);
  await step(['create-service', 'whatsapp', '--confirm', 'whatsapp']);
  const shown = await step(['create-key', 'whatsapp', ...LIMITS, '--client-id', 'whatsapp-service']);
  const userId = idIn(shown, /^ {2}id {10}([0-9a-f-]{36})$/);
  const first = idIn(await step(['create-key', 'whatsapp', ...LIMITS, '--client-id', 'whatsapp-service', '--confirm', userId]), /^Created key ([0-9a-f-]{36})/);
  await step(['list', 'whatsapp']);
  await step(['rotate', 'whatsapp', ...LIMITS, '--confirm', userId]);
  await step(['update-limits', 'whatsapp', '--key', first, '--rate-max', '120', '--rate-window', '60', '--daily', '6000', '--confirm', first]);
  await step(['update-limits', 'whatsapp', '--key', first, '--rate-max', '100001', '--rate-window', '60', '--daily', '6000', '--confirm', first]);
  await step(['create-key', 'whatsapp', ...LIMITS, '--expires-in', '86400', '--confirm', userId]);
  await step(['revoke', 'whatsapp', '--key', first]);
  await step(['revoke', 'whatsapp', '--key', first, '--confirm', first]);
  await step(['list', 'whatsapp']);
  await client.close();

  const text = transcript.join('\n');
  const { username, password, pathname, protocol } = new URL(databaseUrl);
  const leaks = [databaseUrl, `${username}:${password}@`, `${pathname}`, `${protocol}//`].filter((s) => text.includes(s));
  const keys = text.match(/ansari_wa_[A-Za-z]{64}/g) ?? [];
  console.log(`\nCHECK database printed as hostname:port only: ${leaks.length === 0 ? 'PASS' : `FAIL (${leaks.join(', ')})`}`);
  console.log(`CHECK two keys created, each printed once: ${keys.length === 2 && new Set(keys).size === 2 ? 'PASS' : `FAIL (${keys.length})`}`);
  process.exit(leaks.length === 0 && keys.length === 2 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('demo failed:', err instanceof Error ? err.name : 'unknown');
  process.exit(1);
});
