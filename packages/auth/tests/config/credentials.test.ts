// Credentials (spec 300, phase 3): the permanent bcrypt + scrypt dual verify,
// email case on sign-in, and the reset path (token before strength; a reset
// kills every session). Driven through auth.handler on a pglite database built
// from the auth journal.
import { randomUUID } from 'node:crypto';

import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth, INVALID_RESET_TOKEN_MESSAGE, schema, type Auth, type Db } from '../../src/index';
import { isBcryptHash, verifyPassword } from '../../src/password';
import { drizzleFor, migrate, setAuthEnv } from '../helpers/auth-db';
import {
  BASE,
  call,
  insertLegacyUser,
  json,
  legacyBcryptHash,
  mintJwt,
  signIn,
} from '../helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

const STRONG = 'Legacy-Passw0rd!';
const NEW_STRONG = 'Brand-New-Passw0rd!';

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

async function credentialHash(userId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ password: schema.account.password })
    .from(schema.account)
    .where(eq(schema.account.userId, userId));
  return row?.password;
}

/** A reset token as better-auth's request-password-reset stores one (password.mjs:73-79). */
async function issueResetToken(userId: string, expiresAt = new Date(Date.now() + 3_600_000)) {
  const token = `reset-${randomUUID()}`;
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt,
  });
  return token;
}

describe('dual verify: legacy bcrypt hashes', () => {
  it('a migrated user with a $2b$ cost-12 hash signs in with the unchanged password, under the same id', async () => {
    const id = randomUUID();
    await insertLegacyUser(db, {
      id,
      email: 'legacy-2b@example.com',
      passwordHash: await legacyBcryptHash(STRONG),
    });

    const { res } = await signIn(auth, 'legacy-2b@example.com', STRONG);
    expect(res.status).toBe(200);
    expect((await json<{ user: { id: string } }>(res)).user.id).toBe(id);
  });

  it('a $2a$ hash verifies too', async () => {
    const id = randomUUID();
    const hash2a = (await legacyBcryptHash(STRONG)).replace(/^\$2b\$/, '$2a$');
    expect(hash2a.startsWith('$2a$')).toBe(true);
    await insertLegacyUser(db, { id, email: 'legacy-2a@example.com', passwordHash: hash2a });

    expect((await signIn(auth, 'legacy-2a@example.com', STRONG)).res.status).toBe(200);
  });

  it('a wrong password against a bcrypt hash is refused', async () => {
    expect((await signIn(auth, 'legacy-2b@example.com', 'Wrong-Passw0rd!')).res.status).toBe(401);
  });

  it('scenario 8: a bcrypt password longer than 72 bytes verifies truncated, as legacy did', async () => {
    const id = randomUUID();
    const first72 = 'A1-'.padEnd(72, 'x');
    const original = `${first72}${'y'.repeat(28)}`;
    expect(Buffer.byteLength(original)).toBe(100);
    await insertLegacyUser(db, {
      id,
      email: 'legacy-long@example.com',
      passwordHash: await legacyBcryptHash(original),
    });

    // The original verifies, and so does any password sharing its first 72
    // bytes: bcrypt never read past byte 72 when apps/api hashed it.
    expect((await signIn(auth, 'legacy-long@example.com', original)).res.status).toBe(200);
    expect(
      (await signIn(auth, 'legacy-long@example.com', `${first72}${'z'.repeat(10)}`)).res.status
    ).toBe(200);
    // A difference inside the first 72 bytes is still refused.
    expect(
      (await signIn(auth, 'legacy-long@example.com', `B${original.slice(1)}`)).res.status
    ).toBe(401);
  });
});

describe('a stored hash in neither format', () => {
  it.each(['nologin', '', 'not-a-hash-at-all'])('%j verifies false, without throwing', async (hash) => {
    await expect(verifyPassword({ hash, password: STRONG })).resolves.toBe(false);
  });

  it('a sign-in against one answers 401, like a wrong password, not 500', async () => {
    await insertLegacyUser(db, { id: randomUUID(), email: 'no-format@example.com', passwordHash: 'nologin' });
    expect((await signIn(auth, 'no-format@example.com', STRONG)).res.status).toBe(401);
  });
});

describe('dual verify: new hashes are scrypt', () => {
  it('a sign-up stores a scrypt hash, which then signs in', async () => {
    const res = await call(auth, '/sign-up/email', {
      body: { email: 'fresh@example.com', password: STRONG, name: 'Fresh User' },
    });
    expect(res.status).toBe(200);
    const { user } = await json<{ user: { id: string } }>(res);

    const hash = await credentialHash(user.id);
    expect(hash).toBeTruthy();
    expect(isBcryptHash(hash ?? '')).toBe(false);
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);

    expect((await signIn(auth, 'fresh@example.com', STRONG)).res.status).toBe(200);
  });
});

describe('scenario 13: email case on sign-in', () => {
  it('a mixed-case sign-in finds the lowercase row', async () => {
    const id = randomUUID();
    await insertLegacyUser(db, {
      id,
      email: 'mixed.case@example.com',
      passwordHash: await legacyBcryptHash(STRONG),
    });

    const { res } = await signIn(auth, 'Mixed.Case@Example.COM', STRONG);
    expect(res.status).toBe(200);
    expect((await json<{ user: { id: string } }>(res)).user.id).toBe(id);
  });
});

describe('password reset', () => {
  it('a reset kills every live session: the old session token can no longer mint a JWT', async () => {
    const id = randomUUID();
    await insertLegacyUser(db, {
      id,
      email: 'reset-revoke@example.com',
      passwordHash: await legacyBcryptHash(STRONG),
    });
    const first = await signIn(auth, 'reset-revoke@example.com', STRONG);
    const second = await signIn(auth, 'reset-revoke@example.com', STRONG);
    expect(first.token && second.token).toBeTruthy();
    expect((await mintJwt(auth, first.token!)).status).toBe(200);

    const token = await issueResetToken(id);
    const reset = await call(auth, '/reset-password', { body: { token, newPassword: NEW_STRONG } });
    expect(reset.status).toBe(200);

    expect((await mintJwt(auth, first.token!)).status).toBe(401);
    expect((await mintJwt(auth, second.token!)).status).toBe(401);
    // The new password works, with a scrypt hash in place of the bcrypt one.
    expect((await signIn(auth, 'reset-revoke@example.com', NEW_STRONG)).res.status).toBe(200);
    expect(isBcryptHash((await credentialHash(id)) ?? '')).toBe(false);
  });

  it('an unknown token with a weak password gets the token error, not the strength error', async () => {
    const res = await call(auth, '/reset-password', {
      body: { token: 'no-such-token', newPassword: 'weak' },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe(INVALID_RESET_TOKEN_MESSAGE);
  });

  it('a missing token gets the same 400', async () => {
    const res = await call(auth, '/reset-password', { body: { newPassword: NEW_STRONG } });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe(INVALID_RESET_TOKEN_MESSAGE);
  });

  it('an expired token gets the same 400, even with a weak password', async () => {
    const id = randomUUID();
    await insertLegacyUser(db, {
      id,
      email: 'reset-expired@example.com',
      passwordHash: await legacyBcryptHash(STRONG),
    });
    const token = await issueResetToken(id, new Date(Date.now() - 1000));

    const res = await call(auth, '/reset-password', { body: { token, newPassword: 'weak' } });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe(INVALID_RESET_TOKEN_MESSAGE);
  });

  it('a valid token with a weak password gets the legacy strength detail, and the token survives', async () => {
    const id = randomUUID();
    await insertLegacyUser(db, {
      id,
      email: 'reset-weak@example.com',
      passwordHash: await legacyBcryptHash(STRONG),
    });
    const token = await issueResetToken(id);

    const weak = await call(auth, '/reset-password', { body: { token, newPassword: 'aaaaaaaa' } });
    expect(weak.status).toBe(400);
    expect((await json(weak)).message).toBe(
      'Password is too weak. Add uppercase letters Add numbers Add special characters'
    );

    // Refused before consumption: the same token still resets once.
    const ok = await call(auth, '/reset-password', { body: { token, newPassword: NEW_STRONG } });
    expect(ok.status).toBe(200);
    const reused = await call(auth, '/reset-password', { body: { token, newPassword: NEW_STRONG } });
    expect(reused.status).toBe(400);
  });
});
