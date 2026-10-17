// Unit tests for the pure helpers phase 3 adds: env validation (secret
// minimums, never echoing a value), the reservation, name derivation, the
// password-strength port, and the shared X-Ansari-Client parser.
import { CLIENT_HEADER, INVALID_CLIENT, parseClientId } from '@ansari/types/attribution';
import { afterEach, describe, expect, it } from 'vitest';

import { getEnv, resetEnvCache } from '../../src/env';
import { deriveName } from '../../src/name';
import { checkPasswordStrength, isBcryptHash, weakPasswordMessage } from '../../src/password';
import { isReservedAddress, isSystemAddress } from '../../src/reserved';
import { BASE } from '../helpers/http';
import { setAuthEnv } from '../helpers/auth-db';

afterEach(() => {
  setAuthEnv(BASE);
});

describe('env', () => {
  it.each([
    ['BETTER_AUTH_SECRET', 'x'.repeat(31)],
    ['RESEND_API_KEY', 're_'.padEnd(19, 'k')],
    ['AUTH_JWT_ISSUER', 'not-a-url'],
    ['FRONTEND_URL', 'not-a-url'],
    ['AUTH_JWT_AUDIENCE', ''],
  ])('rejects a bad %s, naming it without echoing the value', (name, value) => {
    setAuthEnv(BASE);
    process.env[name] = value;
    resetEnvCache();
    let message = '';
    try {
      getEnv();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(name);
    if (value.length >= 8) expect(message).not.toContain(value);
  });

  it('never echoes a secret that is just under its minimum', () => {
    setAuthEnv(BASE);
    const secret = 'better-auth-secret-value-31-chr';
    const resend = 're_secret_value_19c';
    process.env.BETTER_AUTH_SECRET = secret;
    process.env.RESEND_API_KEY = resend;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/BETTER_AUTH_SECRET, RESEND_API_KEY|RESEND_API_KEY, BETTER_AUTH_SECRET/);
    try {
      getEnv();
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
      expect((err as Error).message).not.toContain(resend);
    }
  });

  it('declares no shared credential, internal port, rate-limit mode or admin list (owner amendment 2026-10-17)', () => {
    setAuthEnv(BASE);
    process.env.ADMIN_EMAILS = 'admin@example.com';
    resetEnvCache();
    const keys = Object.keys(getEnv());
    delete process.env.ADMIN_EMAILS;
    for (const removed of ['AUTH_INTERNAL_SECRET', 'INTERNAL_PORT', 'AUTH_RATE_LIMIT_MODE', 'ADMIN_EMAILS']) {
      expect(keys).not.toContain(removed);
    }
  });
});

describe('reserved addresses: the system domain only', () => {
  it.each([
    ['admin@example.com', false],
    ['ai-skill@system.ansari.chat', true],
    ['Anyone@System.Ansari.Chat', true],
    ['user@example.com', false],
    ['user@notsystem.ansari.chat', false],
    ['system.ansari.chat@example.com', false],
  ])('%s → %s', (email, reserved) => {
    expect(isReservedAddress(email)).toBe(reserved);
  });

  it('isSystemAddress matches the domain only', () => {
    expect(isSystemAddress('leaderboard@system.ansari.chat')).toBe(true);
    expect(isSystemAddress('leaderboard@ansari.chat')).toBe(false);
  });
});

describe('deriveName (the reference rule)', () => {
  it.each([
    ['Amina', 'Yusuf', 'a@example.com', 'Amina Yusuf'],
    ['Amina', null, 'a@example.com', 'Amina'],
    [null, 'Yusuf', 'a@example.com', 'Yusuf'],
    ['  ', '', 'local.part@example.com', 'local.part'],
    [null, null, '@example.com', 'User'],
    [null, null, null, 'User'],
  ])('(%s, %s, %s) → %s', (first, last, email, expected) => {
    expect(deriveName(first, last, email)).toBe(expected);
  });
});

describe('checkPasswordStrength (ported unchanged)', () => {
  it.each([
    ['aaaaaaaa', false, 2],
    ['Aaaaaaaa1', true, 4],
    ['Sign-Up-Passw0rd!', true, 6],
    ['Password123!', true, 4],
    ['Password123', false, 2],
    ['qwertyQWERTY1!', true, 4],
    ['Ab1!', true, 4],
  ])('%s → valid %s, score %i', (password, valid, score) => {
    const result = checkPasswordStrength(password);
    expect(result.valid).toBe(valid);
    expect(result.score).toBe(score);
  });

  it('builds the legacy detail', () => {
    expect(weakPasswordMessage(checkPasswordStrength('aaaaaaaa').suggestions)).toBe(
      'Password is too weak. Add uppercase letters Add numbers Add special characters'
    );
  });

  it('recognizes only $2a$ and $2b$ as bcrypt', () => {
    expect(isBcryptHash('$2a$12$x')).toBe(true);
    expect(isBcryptHash('$2b$12$x')).toBe(true);
    expect(isBcryptHash('$2y$12$x')).toBe(false);
    expect(isBcryptHash('abcd:ef01')).toBe(false);
  });
});

describe('parseClientId (shared with apps/api)', () => {
  it('names the header', () => {
    expect(CLIENT_HEADER).toBe('X-Ansari-Client');
  });

  it.each([
    [null, null, 'absent', null],
    ['askansari-web', null, 'valid', 'askansari-web'],
    ['  MuslimPedia ', null, 'valid', 'muslimpedia'],
    [null, 'partner.ai', 'valid', 'partner.ai'],
    ['bad id!', 'partner.ai', 'invalid', INVALID_CLIENT],
    ['invalid', null, 'invalid', INVALID_CLIENT],
    ['', null, 'invalid', INVALID_CLIENT],
    ['a'.repeat(65), null, 'invalid', INVALID_CLIENT],
  ])('header %j, src %j → %s', (header, src, kind, clientId) => {
    const parsed = parseClientId(header, src);
    expect(parsed.kind).toBe(kind);
    expect(parsed.clientId).toBe(clientId);
  });

  it('reports which source a value came from', () => {
    expect(parseClientId('x', 'y')).toMatchObject({ source: 'header' });
    expect(parseClientId(null, 'y')).toMatchObject({ source: 'query' });
  });
});
