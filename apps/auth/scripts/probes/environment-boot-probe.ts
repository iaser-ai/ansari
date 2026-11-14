/**
 * The production-shaped run for ENVIRONMENT (#314 Amendment 3; second review,
 * finding 12): the BUILT apps/auth (`dist/index.mjs`) started as its own
 * process with NODE_ENV=production, as Railway starts it, for each value of
 * ENVIRONMENT. In-process tests mutate process.env; this proves the rule on
 * the real boot path. Operator-run, after `pnpm --filter ansari-auth build`:
 *
 *   pnpm --filter ansari-auth exec tsx scripts/probes/environment-boot-probe.ts <unreachable database URL>
 *
 * The database URL is an argument, never read from the environment, and
 * should point at a port nothing listens on (e.g. 127.0.0.1:1): the probe
 * needs boot to get past the env check, not a database (apps/auth starts on
 * an unreachable database, by design). No .env is loaded (DOTENV_CONFIG_PATH
 * is /dev/null), so only the values below exist.
 *
 * Expected: absent, `development` and `prod` refuse to boot, naming
 * ENVIRONMENT and no value; `staging` and `production` listen. Each case runs
 * under a deadline (PASS or FAIL, never a hang). The output is pasted into the
 * review (codev/reviews/314-*.md).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.argv[2];
if (!databaseUrl) {
  console.error('usage: environment-boot-probe.ts <unreachable database URL>');
  process.exit(2);
}

const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SECRET = 'probe-secret-'.padEnd(40, 'x');
const BASE: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  DOTENV_CONFIG_PATH: '/dev/null',
  NODE_ENV: 'production',
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: 'https://auth.probe.test',
  CORS_ORIGIN: 'https://app.probe.test',
  AUTH_LAYER_ORIGIN: 'https://api.probe.test',
  AUTH_JWT_ISSUER: 'https://auth.probe.test',
  AUTH_JWT_AUDIENCE: 'ansari-api',
  RESEND_API_KEY: 'r'.repeat(20),
  FRONTEND_URL: 'https://app.probe.test',
  PORT: '31997',
};

type Outcome = { listened: boolean; refusedOn: string | null; leaked: boolean };

function boot(environment: string | undefined, deadlineMs = 20_000): Promise<Outcome> {
  const env = { ...BASE, ...(environment === undefined ? {} : { ENVIRONMENT: environment }) };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['dist/index.mjs'], { cwd: APP_DIR, env });
    let output = '';
    const finish = () => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      const refused = /env validation failed for: ([A-Z_, ]+)\./.exec(output);
      resolve({
        listened: /listening on port/.test(output),
        refusedOn: refused?.[1] ?? null,
        leaked: output.includes(SECRET) || (environment !== undefined && environment !== '' && output.includes(`ENVIRONMENT=${environment}`)),
      });
    };
    const timer = setTimeout(finish, deadlineMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (/listening on port|env validation failed/.test(output)) setTimeout(finish, 200);
      });
    }
    child.on('exit', () => setTimeout(finish, 50));
  });
}

let failed = 0;
for (const [environment, shouldBoot] of [
  [undefined, false],
  ['development', false],
  ['prod', false],
  ['staging', true],
  ['production', true],
] as const) {
  const outcome = await boot(environment);
  const ok = shouldBoot
    ? outcome.listened && outcome.refusedOn === null
    : !outcome.listened && outcome.refusedOn === 'ENVIRONMENT' && !outcome.leaked;
  if (!ok) failed++;
  const what = outcome.listened ? 'listened' : outcome.refusedOn ? `refused (names: ${outcome.refusedOn})` : 'no answer';
  console.log(`${ok ? 'PASS' : 'FAIL'}  NODE_ENV=production ENVIRONMENT=${environment ?? '(absent)'} → ${what}`);
}
process.exit(failed === 0 ? 0 : 1);
