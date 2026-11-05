// The WhatsApp exchange's identity and session core (spec 329, plan phase 5),
// on pglite built from the auth journal. The interleavings (a ban, a deletion,
// a promotion or a re-pointed account row between resolve and lock) run as
// writes between the two calls; the lock itself is proven on real Postgres by
// scripts/probes/exchange-lock-probe.ts, and the transaction's scope by the
// source-level block at the end.
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAuth,
  JWT_LIFETIME_SECONDS,
  SESSION_LIFETIME_SECONDS,
  type Auth,
  type Db,
} from '../src/index';
import { SESSION_MARGIN } from '../src/limits';
import { whatsappAddress } from '../src/reserved';
import { createServiceUser } from '../src/service-users';
import { isSessionLive } from '../src/users';
import {
  issueWhatsappToken,
  resolveOrCreateWhatsappUser,
  WHATSAPP_PROVIDER_ID,
  WHATSAPP_REGISTERED_VIA,
  WHATSAPP_USER_NAME,
  type WhatsappTokenOutcome,
} from '../src/whatsapp';
import { drizzleFor, migrate, setAuthEnv } from './helpers/auth-db';
import { BASE, decodeJwt, json, mintJwt } from './helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');
/** A BSUID shaped like Meta's (`US.` and 20 digits), unique per test. */
const newBsuid = () => `US.${digits(20)}`;

type SessionRow = {
  id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date | null;
  ip_address: string | null;
  user_agent: string | null;
};

async function sessionsOf(userId: string): Promise<SessionRow[]> {
  const { rows } = await client.query<SessionRow>(
    `SELECT id, token, expires_at, created_at, updated_at, ip_address, user_agent
       FROM auth.session WHERE user_id = $1`,
    [userId]
  );
  return rows;
}

async function userRow(userId: string) {
  const { rows } = await client.query<{
    email: string;
    name: string;
    role: string | null;
    registered_via: string | null;
  }>(`SELECT email, name, role, registered_via FROM auth.users WHERE id = $1`, [userId]);
  return rows[0];
}

async function accountsOf(userId: string) {
  const { rows } = await client.query<{ provider_id: string; account_id: string }>(
    `SELECT provider_id, account_id FROM auth.account WHERE user_id = $1`,
    [userId]
  );
  return rows;
}

/** Every (table, column) in the auth schema whose value contains `needle`. */
async function columnsHolding(needle: string): Promise<string[]> {
  const { rows: tables } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'auth' ORDER BY table_name`
  );
  const hits: string[] = [];
  for (const { table_name } of tables) {
    const { rows } = await client.query<{ row: Record<string, unknown> }>(
      `SELECT row_to_json(t) AS row FROM auth."${table_name}" t`
    );
    for (const { row } of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (value !== null && JSON.stringify(value).includes(needle)) hits.push(`${table_name}.${column}`);
      }
    }
  }
  return [...new Set(hits)];
}

function expectIssued(outcome: WhatsappTokenOutcome) {
  if (outcome.kind !== 'issued') throw new Error(`expected a token, got ${outcome.kind}`);
  return outcome;
}

/** A new WhatsApp user with a token issued, as the route would do it. */
async function exchange(bsuid = newBsuid()) {
  const { userId } = await resolveOrCreateWhatsappUser(db, bsuid);
  const outcome = expectIssued(await issueWhatsappToken(auth, db, { userId, bsuid }));
  return { userId, bsuid, ...outcome };
}

describe('resolve or create', () => {
  it('a new BSUID makes one user (exact address), one whatsapp account row and, on issue, one session', async () => {
    const bsuid = newBsuid();
    const resolved = await resolveOrCreateWhatsappUser(db, bsuid);
    expect(resolved.created).toBe(true);

    expect(await userRow(resolved.userId)).toEqual({
      email: whatsappAddress(resolved.userId),
      name: WHATSAPP_USER_NAME,
      role: 'user',
      registered_via: WHATSAPP_REGISTERED_VIA,
    });
    expect(await accountsOf(resolved.userId)).toEqual([
      { provider_id: WHATSAPP_PROVIDER_ID, account_id: bsuid },
    ]);
    const { rows } = await client.query(`SELECT 1 FROM auth.account WHERE user_id = $1 AND password IS NOT NULL`, [
      resolved.userId,
    ]);
    expect(rows).toHaveLength(0);

    expectIssued(await issueWhatsappToken(auth, db, { userId: resolved.userId, bsuid }));
    expect(await sessionsOf(resolved.userId)).toHaveLength(1);
  });

  it('auth.users has no phone_number column (spec 329 §5, owner amendment 2)', async () => {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'phone_number'`
    );
    expect(rows).toHaveLength(0);
  });

  it('a repeat finds the same user and reuses the same session (same sub and sid)', async () => {
    const first = await exchange();
    const again = await resolveOrCreateWhatsappUser(db, first.bsuid);
    expect(again).toEqual({ userId: first.userId, created: false });
    const second = expectIssued(await issueWhatsappToken(auth, db, { userId: first.userId, bsuid: first.bsuid }));
    expect(second.sessionId).toBe(first.sessionId);
    expect(decodeJwt(second.token).payload.sub).toBe(first.userId);
    expect(decodeJwt(second.token).payload.sid).toBe(first.sessionId);
    expect(await sessionsOf(first.userId)).toHaveLength(1);
  });

  it('a concurrent create for the same BSUID loses on the unique constraint and returns the winner', async () => {
    const bsuid = newBsuid();
    const before = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.users`)).rows[0]!.n;
    let winner = '';
    const loser = await resolveOrCreateWhatsappUser(db, bsuid, {
      beforeCreate: async () => {
        winner = (await resolveOrCreateWhatsappUser(db, bsuid)).userId;
      },
    });
    expect(winner).not.toBe('');
    expect(loser).toEqual({ userId: winner, created: false });
    const after = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.users`)).rows[0]!.n;
    expect(after).toBe(before + 1);
    const { rows } = await client.query(
      `SELECT user_id FROM auth.account WHERE provider_id = 'whatsapp' AND account_id = $1`,
      [bsuid]
    );
    expect(rows).toEqual([{ user_id: winner }]);
  });

  it('two creates racing for one BSUID end with one user, both callers getting it', async () => {
    const bsuid = newBsuid();
    const [a, b] = await Promise.all([
      resolveOrCreateWhatsappUser(db, bsuid),
      resolveOrCreateWhatsappUser(db, bsuid),
    ]);
    expect(a.userId).toBe(b.userId);
    const { rows } = await client.query(
      `SELECT user_id FROM auth.account WHERE provider_id = 'whatsapp' AND account_id = $1`,
      [bsuid]
    );
    expect(rows).toHaveLength(1);
  });
});

describe('the session and the token', () => {
  it('a session that would not outlive exp + SESSION_MARGIN is replaced, and the old one deleted', async () => {
    const first = await exchange();
    const tooShort = new Date(Date.now() + JWT_LIFETIME_SECONDS * 1000 + SESSION_MARGIN - 60_000);
    await client.query(`UPDATE auth.session SET expires_at = $1 WHERE id = $2`, [tooShort, first.sessionId]);

    const second = expectIssued(await issueWhatsappToken(auth, db, { userId: first.userId, bsuid: first.bsuid }));
    expect(second.sessionId).not.toBe(first.sessionId);
    const sessions = await sessionsOf(first.userId);
    expect(sessions.map((s) => s.id)).toEqual([second.sessionId]);
    expect(decodeJwt(second.token).payload.sid).toBe(second.sessionId);
  });

  it('a session that outlives exp + SESSION_MARGIN is reused', async () => {
    const first = await exchange();
    const enough = new Date(Date.now() + JWT_LIFETIME_SECONDS * 1000 + SESSION_MARGIN + 60_000);
    await client.query(`UPDATE auth.session SET expires_at = $1 WHERE id = $2`, [enough, first.sessionId]);
    const second = expectIssued(await issueWhatsappToken(auth, db, { userId: first.userId, bsuid: first.bsuid }));
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('every token is signed from a session that outlives its exp by SESSION_MARGIN', async () => {
    const { userId, token } = await exchange();
    const { exp } = decodeJwt(token).payload as { exp: number };
    const [row] = await sessionsOf(userId);
    expect(row!.expires_at.getTime()).toBeGreaterThanOrEqual(exp * 1000 + SESSION_MARGIN);
  });

  it('the claim set equals /api/auth/token\'s, and {sub, sid} equal definePayload\'s for the same session', async () => {
    const { userId, sessionId, token } = await exchange();
    const [row] = await sessionsOf(userId);
    const minted = await mintJwt(auth, row!.token);
    expect(minted.status).toBe(200);
    const reference = decodeJwt((await json<{ token: string }>(minted)).token);
    const exchanged = decodeJwt(token);

    expect(Object.keys(exchanged.payload).sort()).toEqual(Object.keys(reference.payload).sort());
    expect(exchanged.header.alg).toBe(reference.header.alg);
    expect(exchanged.header.kid).toBeDefined();
    expect(exchanged.header.kid).toBe(reference.header.kid);
    expect(exchanged.payload.iss).toBe(reference.payload.iss);
    expect(exchanged.payload.aud).toBe(reference.payload.aud);
    const life = (p: Record<string, unknown>) => Number(p.exp) - Number(p.iat);
    expect(life(exchanged.payload)).toBe(JWT_LIFETIME_SECONDS);
    expect(life(exchanged.payload)).toBe(life(reference.payload));
    // /token's claims are definePayload's output for this same session.
    expect({ sub: exchanged.payload.sub, sid: exchanged.payload.sid }).toEqual({
      sub: reference.payload.sub,
      sid: reference.payload.sid,
    });
    expect({ sub: exchanged.payload.sub, sid: exchanged.payload.sid }).toEqual({ sub: userId, sid: sessionId });
  });

  it('the session row is shaped like one better-auth writes: 32-character [A-Za-z0-9] token, empty IP and agent, updatedAt set, 30 days', async () => {
    const before = Date.now();
    const { userId } = await exchange();
    const [row] = await sessionsOf(userId);
    // A 30-day bearer credential: a fallback to a weaker generator fails here.
    // One token in three from the unrestricted generator has no '-' or '_',
    // so 20 written tokens are checked, not one.
    const bsuid = (await accountsOf(userId))[0]!.account_id;
    const tokens = [row!.token];
    for (let i = 0; i < 19; i++) {
      await client.query(`DELETE FROM auth.session WHERE user_id = $1`, [userId]);
      expectIssued(await issueWhatsappToken(auth, db, { userId, bsuid }));
      tokens.push((await sessionsOf(userId))[0]!.token);
    }
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(row!.ip_address).toBe('');
    expect(row!.user_agent).toBe('');
    expect(row!.updated_at).toBeInstanceOf(Date);
    expect(row!.created_at).toBeInstanceOf(Date);
    const lifetime = row!.expires_at.getTime() - row!.created_at.getTime();
    expect(lifetime).toBe(SESSION_LIFETIME_SECONDS * 1000);
    expect(row!.created_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a directly written session is accepted by the bearer plugin and by the live-sid check', async () => {
    const { userId, sessionId } = await exchange();
    const [row] = await sessionsOf(userId);
    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${row!.token}` }) });
    expect(session?.session.id).toBe(sessionId);
    expect(session?.user.id).toBe(userId);
    expect((await mintJwt(auth, row!.token)).status).toBe(200);
    expect(await isSessionLive(db, sessionId, userId)).toBe(true);
  });
});

describe('where the BSUID lives', () => {
  it('the BSUID is held only in account.account_id', async () => {
    const { bsuid } = await exchange(newBsuid());
    expect(await columnsHolding(bsuid)).toEqual(['account.account_id']);
  });
});

describe('between resolve and lock', () => {
  it('a ban committed first → banned, every session deleted, no token', async () => {
    const { userId, bsuid } = await exchange();
    await resolveOrCreateWhatsappUser(db, bsuid);
    // The ban alone, without the ban script's own session delete: the
    // exchange must delete them itself.
    await client.query(`UPDATE auth.users SET banned = true WHERE id = $1`, [userId]);
    expect(await issueWhatsappToken(auth, db, { userId, bsuid })).toEqual({ kind: 'banned' });
    expect(await sessionsOf(userId)).toHaveLength(0);
  });

  it('an expired ban (ban_expires in the past) is not refused', async () => {
    const bsuid = newBsuid();
    const { userId } = await resolveOrCreateWhatsappUser(db, bsuid);
    await client.query(`UPDATE auth.users SET banned = true, ban_expires = now() - interval '1 hour' WHERE id = $1`, [
      userId,
    ]);
    expectIssued(await issueWhatsappToken(auth, db, { userId, bsuid }));
  });

  it('the user deleted first → user-gone, no session', async () => {
    const bsuid = newBsuid();
    const { userId } = await resolveOrCreateWhatsappUser(db, bsuid);
    await client.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
    expect(await issueWhatsappToken(auth, db, { userId, bsuid })).toEqual({ kind: 'user-gone' });
    expect(await sessionsOf(userId)).toHaveLength(0);
  });
});

describe('eligibility: a row a person could not have made → ineligible, no token, no session', () => {
  async function expectIneligible(userId: string, bsuid: string, reason: string) {
    const outcome = await issueWhatsappToken(auth, db, { userId, bsuid });
    expect(outcome).toEqual({ kind: 'ineligible', reason });
    expect(await sessionsOf(userId)).toHaveLength(0);
  }

  /** A fresh WhatsApp user, resolved but not yet exchanged. */
  async function resolved() {
    const bsuid = newBsuid();
    const { userId } = await resolveOrCreateWhatsappUser(db, bsuid);
    return { userId, bsuid };
  }

  it('a whatsapp row on an email user', async () => {
    const email = `wa-${randomUUID().slice(0, 8)}@example.com`;
    await auth.api.signUpEmail({ body: { name: 'Email', email, password: 'Email-Passw0rd!' } });
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM auth.users WHERE email = $1`, [email]);
    const userId = rows[0]!.id;
    await client.query(`DELETE FROM auth.session WHERE user_id = $1`, [userId]);
    const bsuid = newBsuid();
    await client.query(
      `INSERT INTO auth.account (provider_id, account_id, user_id, updated_at) VALUES ('whatsapp', $1, $2, now())`,
      [bsuid, userId]
    );
    expect((await resolveOrCreateWhatsappUser(db, bsuid)).userId).toBe(userId);
    await expectIneligible(userId, bsuid, 'accounts');
  });

  it('a whatsapp row on a service user', async () => {
    const service = await createServiceUser(db, 'whatsapp');
    const bsuid = newBsuid();
    await client.query(
      `INSERT INTO auth.account (provider_id, account_id, user_id, updated_at) VALUES ('whatsapp', $1, $2, now())`,
      [bsuid, service.id]
    );
    await expectIneligible(service.id, bsuid, 'accounts');
  });

  it('a second account row beside the whatsapp row', async () => {
    const { userId, bsuid } = await resolved();
    await client.query(
      `INSERT INTO auth.account (provider_id, account_id, user_id, password, updated_at) VALUES ('credential', $1::text, $1::uuid, 'x', now())`,
      [userId]
    );
    await expectIneligible(userId, bsuid, 'accounts');
  });

  it("the whatsapp row's account_id changed between resolve and lock", async () => {
    const { userId, bsuid } = await resolved();
    await client.query(`UPDATE auth.account SET account_id = $1 WHERE user_id = $2`, [newBsuid(), userId]);
    await expectIneligible(userId, bsuid, 'accounts');
  });

  it('an admin, or a user promoted between resolve and lock', async () => {
    const { userId, bsuid } = await exchange();
    await client.query(`UPDATE auth.users SET role = 'admin' WHERE id = $1`, [userId]);
    const outcome = await issueWhatsappToken(auth, db, { userId, bsuid });
    expect(outcome).toEqual({ kind: 'ineligible', reason: 'role' });

    const fresh = await resolved();
    await client.query(`UPDATE auth.users SET role = 'admin' WHERE id = $1`, [fresh.userId]);
    await expectIneligible(fresh.userId, fresh.bsuid, 'role');
  });

  // An allowlist, not `role === 'admin'`: the admin plugin reads `user,admin` as admin.
  it.each(['user,admin', 'admin,user', 'moderator', 'User', ''])('any role but exactly user (%j)', async (role) => {
    const { userId, bsuid } = await resolved();
    await client.query(`UPDATE auth.users SET role = $1 WHERE id = $2`, [role, userId]);
    await expectIneligible(userId, bsuid, 'role');
  });

  it('a null role', async () => {
    const { userId, bsuid } = await resolved();
    await client.query(`UPDATE auth.users SET role = NULL WHERE id = $1`, [userId]);
    await expectIneligible(userId, bsuid, 'role');
  });

  it('an altered address', async () => {
    const { userId, bsuid } = await resolved();
    await client.query(`UPDATE auth.users SET email = $1 WHERE id = $2`, [
      `whatsapp-${randomUUID()}@noreply.askansari.ai`,
      userId,
    ]);
    await expectIneligible(userId, bsuid, 'address');
  });

  it('an altered registered_via', async () => {
    const { userId, bsuid } = await resolved();
    await client.query(`UPDATE auth.users SET registered_via = 'web' WHERE id = $1`, [userId]);
    await expectIneligible(userId, bsuid, 'registered_via');
  });

});

describe('source level: what runs under the lock, and what does not', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/whatsapp.ts', import.meta.url)), 'utf8');

  /** The text of a top-level function, from its declaration to its closing brace. */
  function body(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('the eligibility re-read, ban and session write sit in the locked transaction body', () => {
    const locked = body('decideUnderLock');
    const lockAt = locked.indexOf(".for('no key update')");
    expect(lockAt).toBeGreaterThan(-1);
    for (const step of ['.from(account)', 'isBanned(', '.insert(session)']) {
      expect(locked.indexOf(step), step).toBeGreaterThan(lockAt);
    }
    expect(locked.indexOf("set_config('lock_timeout'")).toBeLessThan(lockAt);
    expect(locked.indexOf("set_config('statement_timeout'")).toBeLessThan(lockAt);
  });

  it('signJWT runs after the transaction, and consumeWindow is not in it', () => {
    const locked = body('decideUnderLock');
    expect(locked).not.toContain('signJWT');
    expect(locked).not.toContain('consumeWindow');
    expect(source).not.toContain('consumeWindow');

    const issue = body('issueWhatsappToken');
    const calls = source.match(/decideUnderLock\(/g) ?? [];
    expect(calls).toHaveLength(2); // the declaration and its one call
    const transactionAt = issue.indexOf('db.transaction((tx) => decideUnderLock(');
    expect(transactionAt).toBeGreaterThan(-1);
    expect(issue.indexOf('signJWT')).toBeGreaterThan(transactionAt);
  });
});
