/**
 * The production-shaped run for the WhatsApp exchange (spec 329, plan phase 6):
 * apps/auth's real app, with NODE_ENV=production and the real node-postgres
 * pool, against a throwaway Postgres container that the probe stops and
 * starts under the running service. pglite has one connection and cannot be
 * stopped, so none of this can be shown there. Operator-run:
 *
 *   docker run -d --name probe-pg-329-outage -e POSTGRES_PASSWORD=probe -p 55433:5432 postgres:18
 *   pnpm --filter ansari-auth exec tsx scripts/probes/exchange-outage-probe.ts \
 *     postgres://postgres:probe@127.0.0.1:55433/postgres probe-pg-329-outage
 *   docker rm -f probe-pg-329-outage
 *
 * The container is started WITHOUT --rm, so `docker stop` keeps it for the
 * restart. The URL and the container name are arguments, never read from the
 * environment; the URL must name 127.0.0.1 or localhost. It drops and
 * recreates the `auth` schema.
 *
 * Steps, each under a deadline (PASS or FAIL, never a hang):
 *   1. boot assertion passes; a new BSUID → 200
 *   2. the user's row held FOR UPDATE from another connection → 500 within the lock timeout
 *   3. the container stopped: inside APIKEY_RELATION_CHECK_TTL an unknown key is
 *      the stated 401 residual; after it, a valid and an unknown key both → 500
 *   4. the boot assertion with the database down lets the service start
 *   5. the container started again: /health recovers and the exchange → 200
 *
 * It prints statuses and timings only, never a key, BSUID or token. The output
 * is pasted into the review (codev/reviews/329-*.md).
 */
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, limits, serviceUsers } from '@ansari/auth';

import {
  connect,
  localUrlFromArgs,
  resetSchema,
  serverVersion,
  setProbeEnv,
} from '../../../../packages/auth/scripts/probes/probe-db';
import { createApp, createServiceAuth } from '../../src/app';
import { assertSchema } from '../../src/boot';
import { WHATSAPP_SESSION_PATH } from '../../src/routes/whatsapp';

const DEADLINE_MS = 20_000;
let failures = 0;

function record(step: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no result within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { url } = localUrlFromArgs('exchange-outage-probe.ts');
const container = process.argv[3];
if (!container) {
  console.error('Usage: exchange-outage-probe.ts <postgres URL> <container name>');
  process.exit(2);
}

console.log(`Postgres ${await serverVersion(url)}; container ${container}`);
await resetSchema(url);
setProbeEnv(url);
process.env.NODE_ENV = 'production';

const db = createDb();
const auth = createServiceAuth(db);
const owner = await serviceUsers.createServiceUser(db, 'whatsapp');
const { key } = await auth.api.createApiKey({
  body: { userId: owner.id, prefix: 'ansari_wa_', permissions: { whatsapp: ['mint'] }, rateLimitEnabled: false },
});
const unknown = `ansari_wa_${'Z'.repeat(64)}`;
const bsuid = `US.${Date.now()}`;

const bootOk = await assertSchema(db);
record('1a boot assertion, schema present', bootOk, `assertSchema → ${bootOk}`);

const server = await new Promise<Server>((resolve) => {
  const s = createApp({ auth, db }).listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function exchange(bearer: string): Promise<{ status: number; ms: number }> {
  const started = Date.now();
  const res = await within(
    DEADLINE_MS,
    fetch(`${base}${WHATSAPP_SESSION_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bsuid }),
    })
  );
  await res.arrayBuffer();
  return { status: res.status, ms: Date.now() - started };
}

async function step(name: string, expected: number[], bearer: string): Promise<void> {
  try {
    const { status, ms } = await exchange(bearer);
    record(name, expected.includes(status), `${status} in ${ms} ms (expected ${expected.join(' or ')})`);
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : 'unknown');
  }
}

try {
  await step('1b new BSUID, valid key', [200], key);

  // 2. Another connection holds the user's row with a lock that conflicts
  // with FOR NO KEY UPDATE; lock_timeout must turn the wait into a 500.
  const holder = await connect(url);
  try {
    await holder.query('BEGIN');
    await holder.query(
      `SELECT 1 FROM auth.users WHERE id = (SELECT user_id FROM auth.account WHERE provider_id = 'whatsapp' AND account_id = $1) FOR UPDATE`,
      [bsuid]
    );
    const { status, ms } = await exchange(key);
    record(
      '2  user row held FOR UPDATE elsewhere',
      status === 500 && ms < limits.EXCHANGE_LOCK_TIMEOUT + 3_000,
      `${status} in ${ms} ms (expected 500 within lock_timeout ${limits.EXCHANGE_LOCK_TIMEOUT} ms + slack)`
    );
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
  }

  // 3. Prime the relation-check cache, then stop the database under the service.
  await step('3a unknown key, database up (primes the relation check)', [401], unknown);
  execFileSync('docker', ['stop', container], { stdio: 'ignore' });
  console.log(`      docker stop ${container}`);
  await step('3b unknown key inside APIKEY_RELATION_CHECK_TTL (stated residual)', [401, 500], unknown);
  await sleep(limits.APIKEY_RELATION_CHECK_TTL + 500);
  await step('3c valid key after the TTL', [500], key);
  await step('3d unknown key after the TTL', [500], unknown);

  // 4. A fresh pool, as a deploy would boot with the database down.
  const coldDb = createDb();
  const starts = await within(DEADLINE_MS, assertSchema(coldDb));
  record('4  boot assertion, database down', starts, `assertSchema → ${starts} (expected true: start, /health reports)`);
  await coldDb.$client.end();
  const health = await fetch(`${base}/health`);
  record('4b /health with the database down', health.status === 503, `${health.status}`);

  // 5. Start the container again; the same running service recovers.
  execFileSync('docker', ['start', container], { stdio: 'ignore' });
  console.log(`      docker start ${container}`);
  let healthy = false;
  const deadline = Date.now() + 60_000;
  while (!healthy && Date.now() < deadline) {
    healthy = (await fetch(`${base}/health`)).status === 200;
    if (!healthy) await sleep(500);
  }
  record('5a /health recovers without a restart', healthy, healthy ? '200' : 'still down after 60 s');
  await step('5b valid key after recovery', [200], key);
  await step('5c unknown key after recovery', [401], unknown);
} finally {
  await new Promise((r) => server.close(r));
  await db.$client.end();
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
