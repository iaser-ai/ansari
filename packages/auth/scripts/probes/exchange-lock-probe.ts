/**
 * Probe 4 (spec 329, plan phase 1): the WhatsApp exchange's locking and pool
 * behaviour against a REAL Postgres. pglite serializes connections, so none of
 * this can be shown there. Operator-run, against a throwaway container only:
 *
 *   docker run --rm -d --name probe-pg -e POSTGRES_PASSWORD=probe -p 55432:5432 postgres:18
 *   pnpm --filter ansari-auth exec tsx ../../packages/auth/scripts/probes/exchange-lock-probe.ts \
 *     postgres://postgres:probe@127.0.0.1:55432/postgres
 *
 * The URL is an argument, never read from the environment, so this script can
 * never be pointed at a real database by an inherited variable. It refuses any
 * host other than 127.0.0.1 or localhost. It drops and recreates the `auth`
 * schema from the journal.
 *
 * Every step runs under a deadline and reports PASS or FAIL; it never hangs.
 * The output is pasted into the review (codev/reviews/329-*.md).
 */
import { randomUUID } from 'node:crypto';

import { generateRandomString } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';

import { createAuth, limits, whatsapp, type Db } from '../../src/index';
import * as schema from '../../src/schema';
import { connect, localUrlFromArgs, resetSchema, serverVersion, setProbeEnv } from './probe-db';

const DEADLINE_MS = 10_000;

type Result = { step: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
}

class Deadline extends Error {}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline(`no result within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errCode(err: unknown): string {
  if (err instanceof Deadline) return 'DEADLINE';
  // Drizzle wraps a driver error in a query error; the SQLSTATE is on its cause.
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } };
  return String(e.code ?? e.cause?.code ?? e.name ?? 'unknown');
}

async function newUser(client: Client): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO auth.users (id, name, email) VALUES ($1, 'Probe', $2)`, [
    id,
    `whatsapp-${id}@noreply.askansari.ai`,
  ]);
  return id;
}

const INSERT_SESSION = `INSERT INTO auth.session (token, expires_at, updated_at, user_id, ip_address, user_agent)
                        VALUES ($1, now() + interval '30 days', now(), $2, '', '')`;
const token = () => generateRandomString(32, 'a-z', 'A-Z', '0-9');

async function sessionCount(client: Client, userId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1',
    [userId]
  );
  return rows[0]!.n;
}

/** A: the exchange's own session insert, inside its locking transaction, does not wait. */
async function stepSameTransaction(url: string): Promise<void> {
  const step = 'A same-transaction session insert under FOR NO KEY UPDATE';
  const a = await connect(url);
  try {
    const userId = await newUser(a);
    await within(DEADLINE_MS, (async () => {
      await a.query('BEGIN');
      await a.query('SELECT id FROM auth.users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
      await a.query(INSERT_SESSION, [token(), userId]);
      await a.query('COMMIT');
    })());
    record(step, (await sessionCount(a, userId)) === 1, 'committed without waiting; 1 session');
  } catch (err) {
    record(step, false, errCode(err));
  } finally {
    await a.end();
  }
}

/** B: a ban on another connection waits for the exchange, then deletes its session. */
async function stepBanWaits(url: string): Promise<void> {
  const step = 'B concurrent ban waits for the exchange, then deletes its session';
  const a = await connect(url);
  const b = await connect(url);
  try {
    const userId = await newUser(a);
    await a.query('BEGIN');
    await a.query('SELECT id FROM auth.users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
    let banDoneAt = 0;
    const ban = (async () => {
      await b.query('BEGIN');
      await b.query('UPDATE auth.users SET banned = true WHERE id = $1', [userId]);
      await b.query('DELETE FROM auth.session WHERE user_id = $1', [userId]);
      await b.query('COMMIT');
      banDoneAt = Date.now();
    })();
    await sleep(300);
    const waitedWhileLocked = banDoneAt === 0;
    await a.query(INSERT_SESSION, [token(), userId]);
    await a.query('COMMIT');
    const exchangeCommittedAt = Date.now();
    await within(DEADLINE_MS, ban);
    const left = await sessionCount(a, userId);
    record(
      step,
      waitedWhileLocked && banDoneAt >= exchangeCommittedAt && left === 0,
      `ban waited: ${waitedWhileLocked}; ban finished after exchange commit: ${banDoneAt >= exchangeCommittedAt}; sessions left: ${left}`
    );
  } catch (err) {
    record(step, false, errCode(err));
  } finally {
    await a.end();
    await b.end();
  }
}

/** C: a session insert from ANOTHER connection is not blocked (FK KEY SHARE vs NO KEY UPDATE). */
async function stepOtherConnectionInsert(url: string): Promise<void> {
  const step = 'C session insert from another connection does not wait on FOR NO KEY UPDATE';
  const a = await connect(url);
  const b = await connect(url);
  try {
    const userId = await newUser(a);
    await a.query('BEGIN');
    await a.query('SELECT id FROM auth.users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
    await within(2_000, b.query(INSERT_SESSION, [token(), userId]));
    await a.query('COMMIT');
    record(step, true, 'insert completed while the lock was held');
  } catch (err) {
    await a.query('ROLLBACK').catch(() => undefined);
    record(step, false, errCode(err));
  } finally {
    await a.end();
    await b.end().catch(() => undefined);
  }
}

/** C': contrast, FOR UPDATE (the strong lock) DOES block the other connection's insert. */
async function stepForUpdateBlocks(url: string): Promise<void> {
  const step = "C' contrast: FOR UPDATE blocks another connection's session insert (the hazard)";
  const a = await connect(url);
  const b = await connect(url);
  try {
    const userId = await newUser(a);
    await a.query('BEGIN');
    await a.query('SELECT id FROM auth.users WHERE id = $1 FOR UPDATE', [userId]);
    await b.query("SET statement_timeout = '1500ms'");
    let code = 'none';
    try {
      await within(5_000, b.query(INSERT_SESSION, [token(), userId]));
    } catch (err) {
      code = errCode(err);
    }
    await a.query('ROLLBACK');
    record(step, code === '57014', `other connection's insert: ${code} (57014 = cancelled by statement_timeout, i.e. it waited)`);
  } catch (err) {
    record(step, false, errCode(err));
  } finally {
    await a.end();
    await b.end();
  }
}

/** D: lock_timeout turns a held row lock into 55P03, not a hang. */
async function stepLockTimeout(url: string): Promise<void> {
  const step = 'D lock_timeout turns a held lock into 55P03';
  const a = await connect(url);
  const b = await connect(url);
  try {
    const userId = await newUser(a);
    await a.query('BEGIN');
    await a.query('SELECT id FROM auth.users WHERE id = $1 FOR UPDATE', [userId]);
    await b.query('BEGIN');
    await b.query("SET LOCAL lock_timeout = '500ms'");
    let code = 'none';
    try {
      await within(5_000, b.query('SELECT id FROM auth.users WHERE id = $1 FOR NO KEY UPDATE', [userId]));
    } catch (err) {
      code = errCode(err);
    }
    await b.query('ROLLBACK');
    await a.query('ROLLBACK');
    record(step, code === '55P03', `waiting exchange got: ${code}`);
  } catch (err) {
    record(step, false, errCode(err));
  } finally {
    await a.end();
    await b.end();
  }
}

/**
 * E: pool starvation. 10 concurrent exchanges against a pool of 2 connections.
 * Each locks its user, writes a session and commits, then signs with the real
 * `auth.api.signJWT` (which reads auth.jwks through the pool). With signing
 * OUTSIDE the transaction all finish. With signing INSIDE, and no connect
 * timeout, each transaction holds a connection while waiting for another: the
 * deadline fires, which is the hang. With a connect timeout it fails loudly.
 */
async function stepPool(url: string, signInside: boolean, connectTimeout: number | undefined): Promise<void> {
  const label = signInside
    ? `E2 signing INSIDE the transaction, pool max 2${connectTimeout ? `, connect timeout ${connectTimeout} ms` : ', no connect timeout'}`
    : 'E1 signing AFTER commit, pool max 2';
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: connectTimeout });
  pool.on('error', () => undefined);
  const db = drizzle({ client: pool, schema }) as unknown as Db;
  setProbeEnv(url);
  const auth = createAuth(db);
  const seed = await connect(url);
  const users = await Promise.all(Array.from({ length: 10 }, () => newUser(seed)));
  await seed.end();
  // Mint the signing key once, so every exchange only reads it.
  await auth.api.signJWT({ body: { payload: { sub: users[0], sid: randomUUID() } } });

  const exchange = async (userId: string) => {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 15 * 60;
    let sid = '';
    let signed = '';
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SELECT id FROM auth.users WHERE id = ${userId} FOR NO KEY UPDATE`);
      const inserted = await tx.execute<{ id: string }>(
        sql`INSERT INTO auth.session (token, expires_at, updated_at, user_id, ip_address, user_agent)
            VALUES (${token()}, now() + interval '30 days', now(), ${userId}, '', '') RETURNING id`
      );
      sid = inserted.rows[0]!.id;
      if (signInside) {
        signed = (await auth.api.signJWT({ body: { payload: { sub: userId, sid, iat, exp } } })).token;
      }
    });
    if (!signInside) {
      signed = (await auth.api.signJWT({ body: { payload: { sub: userId, sid, iat, exp } } })).token;
    }
    return signed;
  };

  const settled = await within(
    DEADLINE_MS,
    Promise.allSettled(users.map((u) => exchange(u)))
  ).catch((err: unknown) => err);

  if (settled instanceof Deadline) {
    record(label, signInside, `deadline: the run HUNG (${DEADLINE_MS} ms)${signInside ? ', as expected for signing inside' : ''}`);
  } else if (Array.isArray(settled)) {
    const ok = settled.filter((s) => s.status === 'fulfilled').length;
    const codes = settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => errCode(s.reason));
    const detail = `${ok}/10 finished${codes.length ? `; failures: ${[...new Set(codes)].join(', ')}` : ''}`;
    if (signInside) record(label, connectTimeout !== undefined && codes.length > 0, `${detail} (loud failure, no hang)`);
    else record(label, ok === 10, detail);
  } else {
    record(label, false, errCode(settled));
  }
  // A hung run leaves clients checked out; do not wait for them.
  void pool.end().catch(() => undefined);
}

/**
 * F: the same properties through the real phase 5 functions
 * (`resolveOrCreateWhatsappUser`, `issueWhatsappToken`), on a pool of 2 with
 * a connect timeout, as apps/auth would run them. Concurrency here is real,
 * which pglite cannot show.
 */
async function stepRealFunctions(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 2_000 });
  pool.on('error', () => undefined);
  const db = drizzle({ client: pool, schema }) as unknown as Db;
  setProbeEnv(url);
  const auth = createAuth(db);
  const bsuid = () => `US.${generateRandomString(20, '0-9')}`;
  const other = await connect(url);
  try {
    // F1: ten concurrent first exchanges for ONE new BSUID: one user, one
    // whatsapp row, one session; every caller gets the same sub and sid.
    {
      const step = 'F1 real functions: 10 concurrent exchanges for one new BSUID';
      const id = bsuid();
      try {
        const outcomes = await within(
          DEADLINE_MS,
          Promise.all(
            Array.from({ length: 10 }, async () => {
              const { userId } = await whatsapp.resolveOrCreateWhatsappUser(db, id);
              return { userId, outcome: await whatsapp.issueWhatsappToken(auth, db, { userId, bsuid: id }) };
            })
          )
        );
        const users = new Set(outcomes.map((o) => o.userId));
        const sids = new Set(outcomes.map((o) => (o.outcome.kind === 'issued' ? o.outcome.sessionId : o.outcome.kind)));
        const [userId] = users;
        const { rows } = await other.query<{ accounts: number; sessions: number }>(
          `SELECT (SELECT count(*)::int FROM auth.account WHERE provider_id = 'whatsapp' AND account_id = $1) AS accounts,
                  (SELECT count(*)::int FROM auth.session WHERE user_id = $2) AS sessions`,
          [id, userId]
        );
        const { accounts, sessions } = rows[0]!;
        record(
          step,
          users.size === 1 && sids.size === 1 && accounts === 1 && sessions === 1,
          `distinct users: ${users.size}; distinct sids: ${sids.size}; whatsapp rows: ${accounts}; sessions: ${sessions}`
        );
      } catch (err) {
        record(step, false, errCode(err));
      }
    }

    // F2: a session insert holding KEY SHARE on the user (open, on another
    // connection) does not block the real exchange.
    {
      const step = "F2 real functions: another connection's open session insert does not block the exchange";
      const id = bsuid();
      try {
        const { userId } = await whatsapp.resolveOrCreateWhatsappUser(db, id);
        await other.query('BEGIN');
        await other.query(INSERT_SESSION, [token(), userId]);
        const outcome = await within(DEADLINE_MS, whatsapp.issueWhatsappToken(auth, db, { userId, bsuid: id }));
        await other.query('ROLLBACK');
        record(step, outcome.kind === 'issued', `exchange outcome while the insert was open: ${outcome.kind}`);
      } catch (err) {
        await other.query('ROLLBACK').catch(() => undefined);
        record(step, false, errCode(err));
      }
    }

    // F3: a ban holding the user row (open, on another connection) makes the
    // real exchange fail with its own lock_timeout (55P03), not hang.
    {
      const step = 'F3 real functions: a held ban update fails the exchange with 55P03 within its lock_timeout';
      const id = bsuid();
      try {
        const { userId } = await whatsapp.resolveOrCreateWhatsappUser(db, id);
        await other.query('BEGIN');
        await other.query('UPDATE auth.users SET banned = true WHERE id = $1', [userId]);
        const started = Date.now();
        const result = await within(
          DEADLINE_MS,
          whatsapp.issueWhatsappToken(auth, db, { userId, bsuid: id }).then(
            (o) => o.kind,
            (err: unknown) => errCode(err)
          )
        );
        const waited = Date.now() - started;
        await other.query('COMMIT');
        const after = await within(DEADLINE_MS, whatsapp.issueWhatsappToken(auth, db, { userId, bsuid: id }));
        record(
          step,
          result === '55P03' && waited < limits.EXCHANGE_LOCK_TIMEOUT + 1_500 && after.kind === 'banned',
          `exchange got ${result} after ${waited} ms (lock_timeout ${limits.EXCHANGE_LOCK_TIMEOUT} ms); after the ban committed: ${after.kind}`
        );
      } catch (err) {
        await other.query('ROLLBACK').catch(() => undefined);
        record(step, false, errCode(err));
      }
    }

    // F4: pool starvation through the real functions: 10 different new
    // users at once on a pool of 2, each resolving, locking, writing a
    // session, committing and signing (which reads jwks on the pool).
    {
      const step = 'F4 real functions: 10 concurrent new users on a pool of 2 (sign after commit)';
      try {
        const settled = await within(
          DEADLINE_MS,
          Promise.allSettled(
            Array.from({ length: 10 }, async () => {
              const id = bsuid();
              const { userId } = await whatsapp.resolveOrCreateWhatsappUser(db, id);
              return whatsapp.issueWhatsappToken(auth, db, { userId, bsuid: id });
            })
          )
        );
        const issued = settled.filter((s) => s.status === 'fulfilled' && s.value.kind === 'issued').length;
        const codes = settled
          .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
          .map((s) => errCode(s.reason));
        record(step, issued === 10, `${issued}/10 issued${codes.length ? `; failures: ${[...new Set(codes)].join(', ')}` : ''}`);
      } catch (err) {
        record(step, false, errCode(err));
      }
    }
  } finally {
    await other.end();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const { url, host } = localUrlFromArgs('exchange-lock-probe.ts');
  console.log(`Probe 4 against Postgres ${await serverVersion(url)} at ${host} (${new Date().toISOString()})`);

  await resetSchema(url);
  await stepSameTransaction(url);
  await stepBanWaits(url);
  await stepOtherConnectionInsert(url);
  await stepForUpdateBlocks(url);
  await stepLockTimeout(url);
  await stepPool(url, false, undefined);
  await stepPool(url, true, undefined);
  await stepPool(url, true, 2_000);
  await stepRealFunctions(url);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps as expected.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
