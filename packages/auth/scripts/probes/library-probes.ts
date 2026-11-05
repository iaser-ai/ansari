/**
 * Probes 2 and the session-token probe (spec 329, plan phase 1) against a
 * REAL Postgres, as the gate before phase 5 requires. The same behaviours are
 * pinned on pglite in tests/config/api-key.test.ts; this run prints what was
 * observed so the output can be pasted into the review. Operator-run, against a
 * throwaway container only:
 *
 *   docker run --rm -d --name probe-pg -e POSTGRES_PASSWORD=probe -p 55432:5432 postgres:18
 *   pnpm --filter ansari-auth exec tsx ../../packages/auth/scripts/probes/library-probes.ts \
 *     postgres://postgres:probe@127.0.0.1:55432/postgres
 *
 * It drops and recreates the `auth` schema from the journal. It prints claim
 * names, headers and shapes, never a token.
 */
import { randomUUID } from 'node:crypto';

import { generateRandomString } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { createAuth, type Auth, type Db } from '../../src/index';
import * as schema from '../../src/schema';
import { localUrlFromArgs, resetSchema, serverVersion, setProbeEnv } from './probe-db';

const BASE = 'http://localhost:3100';

type Result = { step: string; ok: boolean };
const results: Result[] = [];

function record(step: string, ok: boolean, observed: string[]): void {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}`);
  for (const line of observed) console.log(`      ${line}`);
}

let ipCounter = 0;

async function call(auth: Auth, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<Response> {
  ipCounter += 1;
  const headers = new Headers({ origin: BASE, 'x-real-ip': `198.51.100.${ipCounter}` });
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: opts.body === undefined ? 'GET' : 'POST',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  );
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header, payload] = token.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
  return { header, payload };
}

async function signUpAndIn(auth: Auth, pool: Pool, label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
  const password = 'Probe-Passw0rd!';
  await auth.api.signUpEmail({ body: { name: 'Probe', email, password } });
  const res = await call(auth, '/sign-in/email', { body: { email, password } });
  const sessionToken = ((await res.clone().json()) as { token: string }).token;
  const { rows } = await pool.query<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM auth.session WHERE token = $1',
    [sessionToken]
  );
  return { email, password, res, sessionToken, sid: rows[0]!.id, sub: rows[0]!.user_id };
}

async function probe2(auth: Auth, pool: Pool): Promise<void> {
  const { sessionToken, sid, sub } = await signUpAndIn(auth, pool, 'jwt');
  const tokenRes = await call(auth, '/token', { bearer: sessionToken });
  const reference = decodeJwt(((await tokenRes.json()) as { token: string }).token);

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 15 * 60;
  const exchange = decodeJwt((await auth.api.signJWT({ body: { payload: { sub, sid, iat, exp } } })).token);
  const keys = (p: Record<string, unknown>) => Object.keys(p).sort().join(',');
  const life = (p: Record<string, unknown>) => Number(p.exp) - Number(p.iat);

  const sameKeys = keys(exchange.payload) === keys(reference.payload);
  const sameAlg = exchange.header.alg === reference.header.alg;
  const sameIss = exchange.payload.iss === reference.payload.iss;
  const sameAud = exchange.payload.aud === reference.payload.aud;
  const sameLife = life(exchange.payload) === life(reference.payload);
  const honoured = exchange.payload.exp === exp && exchange.payload.iat === iat;
  record('2 signJWT({sub, sid, iat, exp}) matches a /api/auth/token JWT; the passed exp is honoured',
    sameKeys && sameAlg && sameIss && sameAud && sameLife && honoured, [
      `/token  header ${JSON.stringify(reference.header)}  claims [${keys(reference.payload)}]`,
      `signJWT header ${JSON.stringify(exchange.header)}  claims [${keys(exchange.payload)}]`,
      `iss: /token ${String(reference.payload.iss)} | signJWT ${String(exchange.payload.iss)}`,
      `aud: /token ${String(reference.payload.aud)} | signJWT ${String(exchange.payload.aud)}`,
      `exp - iat: /token ${life(reference.payload)} s | signJWT ${life(exchange.payload)} s`,
      `sub = user id: ${exchange.payload.sub === sub}; sid = session id: ${exchange.payload.sid === sid}`,
      `passed exp ${exp} -> signed exp ${String(exchange.payload.exp)}; passed iat ${iat} -> signed iat ${String(exchange.payload.iat)}`,
    ]);

  const bare = decodeJwt((await auth.api.signJWT({ body: { payload: { sub, sid } } })).token);
  record('2 without iat the claim set differs (why the exchange passes it)', !('iat' in bare.payload), [
    `signJWT({sub, sid}) claims [${keys(bare.payload)}]`,
  ]);
}

async function probeSessionToken(auth: Auth, pool: Pool): Promise<void> {
  const id = randomUUID();
  await pool.query(`INSERT INTO auth.users (id, name, email) VALUES ($1, 'svc', $2)`, [
    id,
    `whatsapp-${id}@noreply.askansari.ai`,
  ]);
  const { internalAdapter } = await auth.$context;
  const created = await internalAdapter.createSession(id);
  const { rows } = await pool.query<{ len: number; shape: boolean }>(
    `SELECT length(token)::int AS len, token ~ '^[A-Za-z0-9]{32}$' AS shape FROM auth.session WHERE token = $1`,
    [created.token]
  );
  const samples = Array.from({ length: 1000 }, () => generateRandomString(32, 'a-z', 'A-Z', '0-9'));
  const generated = samples.every((t) => /^[A-Za-z0-9]{32}$/.test(t));
  const alphabet = new Set(samples.join(''));
  const unrestricted = Array.from({ length: 200 }, () => generateRandomString(32)).join('');
  record('session token: generateRandomString(32, a-z, A-Z, 0-9) has the shape createSession writes',
    rows[0]!.len === 32 && rows[0]!.shape && generated && /[-_]/.test(unrestricted), [
      `createSession row token: length ${rows[0]!.len}, matches ^[A-Za-z0-9]{32}$: ${rows[0]!.shape}`,
      `generator, 1000 samples: all match: ${generated}; distinct characters seen: ${alphabet.size} of 62`,
      `without the explicit alphabet, 200 samples contain '-' or '_': ${/[-_]/.test(unrestricted)}`,
    ]);
}

async function main(): Promise<void> {
  const { url, host } = localUrlFromArgs('library-probes.ts');
  console.log(`Probes 2 and session token against Postgres ${await serverVersion(url)} at ${host} (${new Date().toISOString()})`);
  await resetSchema(url);
  setProbeEnv(url);
  const pool = new Pool({ connectionString: url, max: 4 });
  const auth = createAuth(drizzle({ client: pool, schema }) as unknown as Db);
  try {
    await probe2(auth, pool);
    await probeSessionToken(auth, pool);
  } finally {
    await pool.end();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps as expected.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
