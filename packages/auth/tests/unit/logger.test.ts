// Better Auth's logger, redacted (spec 329, plan phase 2, probe 3). Every Error
// argument becomes exactly {name, code}; the level, the message and every other
// argument survive, so the logger is redacted, not silenced. The plugin's own
// catch-and-log path is exercised with the auth.apikey relation dropped, which
// also pins the outage mapping the exchange relies on (phase 6).
import { randomUUID } from 'node:crypto';

import type { PGlite } from '@electric-sql/pglite';
import { DatabaseError } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuth, type Auth } from '../../src/index';
import { logBetterAuth, redactError, redactLogArgs } from '../../src/logger';
import { drizzleFor, migrate, setAuthEnv } from '../helpers/auth-db';
import { BASE } from '../helpers/http';

const EMAIL = 'leaked.person@example.com';

/** A pg server error as node-postgres builds it: its `name` is the protocol message type, 'error'. */
function driverError(): DatabaseError {
  const err = new DatabaseError(
    `relation "auth.apikey" does not exist (key)=(${EMAIL})`,
    120,
    'error'
  );
  err.code = '42P01';
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('redactError and redactLogArgs', () => {
  it('reduces a pg DatabaseError to exactly {name, code}', () => {
    expect(redactError(driverError())).toEqual({ name: 'error', code: '42P01' });
  });

  it("takes the code from the cause when the error has none (a driver error wrapped by Drizzle)", () => {
    const wrapped = new Error(`Failed query: select ... params: ${EMAIL}`, { cause: driverError() });
    wrapped.name = 'DrizzleQueryError';
    expect(redactError(wrapped)).toEqual({ name: 'DrizzleQueryError', code: '42P01' });
  });

  it('gives {name} alone when there is no code anywhere', () => {
    expect(redactError(new TypeError('boom'))).toEqual({ name: 'TypeError' });
  });

  it('leaves near misses unchanged: a plain object with name/code fields, a string, a number', () => {
    const plain = { name: 'NotAnError', code: 'X1', message: 'kept as is' };
    expect(redactLogArgs([plain, 'a string', 42])).toEqual([plain, 'a string', 42]);
  });
});

describe('logBetterAuth', () => {
  it('writes at the matching level, keeping the message and non-error arguments', () => {
    const spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    };
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      logBetterAuth(level, `a ${level} message`, { detail: 1 });
      expect(spies[level]).toHaveBeenCalledWith(`[Better Auth] ${level.toUpperCase()}: a ${level} message`, {
        detail: 1,
      });
    }
  });

  it('never passes an Error through: a driver error arrives as {name, code}', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logBetterAuth('error', 'Failed to validate API key:', driverError());
    expect(error).toHaveBeenCalledWith('[Better Auth] ERROR: Failed to validate API key:', {
      name: 'error',
      code: '42P01',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(EMAIL);
  });
});

describe('createAuth uses the redacted logger', () => {
  let client: PGlite;
  let auth: Auth;

  beforeEach(async () => {
    setAuthEnv(BASE);
    client = await migrate();
    auth = createAuth(drizzleFor(client));
  });

  afterEach(async () => {
    await client?.close();
  });

  it('a non-error log survives with its level and message (a disabled logger fails this)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { logger } = await auth.$context;
    logger.warn('probe: still logging', { kept: true });
    expect(warn).toHaveBeenCalledWith('[Better Auth] WARN: probe: still logging', { kept: true });
  });

  it('auth.apikey dropped: verifyApiKey answers valid:false / INVALID_API_KEY and logs only {name, code}', async () => {
    const userId = randomUUID();
    await client.query(`INSERT INTO auth.users (id, name, email) VALUES ($1, 'svc', $2)`, [
      userId,
      `service-${userId.slice(0, 8)}@noreply.askansari.ai`,
    ]);
    const created = await auth.api.createApiKey({
      body: { userId, prefix: 'ansari_wa_', permissions: { whatsapp: ['mint'] }, rateLimitEnabled: false },
    });
    await client.query('DROP TABLE auth.apikey');

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await auth.api.verifyApiKey({
      body: { key: created.key, permissions: { whatsapp: ['mint'] } },
    });

    // The outage reads exactly like an unknown key: why phase 6 checks the relation before any 401.
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('INVALID_API_KEY');

    expect(error).toHaveBeenCalled();
    const args = error.mock.calls.flatMap((call) => call.slice(1));
    for (const arg of args) expect(arg).not.toBeInstanceOf(Error);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('42P01');
    expect(logged).not.toContain('does not exist');
    expect(logged).not.toContain(created.key);
  });
});
