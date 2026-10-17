// apps/auth's own limiters (limits/email-limiter.ts; owner amendment
// 2026-10-17): none keyed by client IP. Reset requests per email and globally,
// reset consumes globally, the session -> JWT exchange per session, sign-in and
// sign-up per email (scenario 32) with the list-walk alert, and the layer's
// view: every call from ONE IP (apps/api's), never refused for sharing it.
// Time moves with a faked Date, which both better-auth's router and these
// limiters read.
import { createHmac, randomUUID } from 'node:crypto';

import { limits, touchKey } from '@ansari/auth';
import * as Sentry from '@sentry/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LIST_WALK_MESSAGE, type FailedSignInAlert, type ListWalkAlert } from '../src/alerts';
import { emailHash, emailKey, globalKey, sessionKey, sessionTokenOf } from '../src/limits/email-limiter';
import {
  clearSignUpCeiling,
  rateLimitKeys,
  rateLimitRow,
  send,
  signIn,
  signUp,
  signUpTokens,
  startService,
  STRONG_PASSWORD,
  type Service,
} from './helpers/service';

const RESET = '/api/auth/request-password-reset';
/** BETTER_AUTH_SECRET in tests (packages/auth tests/helpers/auth-db.ts setAuthEnv). */
const AUTH_SECRET = 'test-secret-at-least-32-characters-long-000';

function advance(seconds: number): void {
  vi.setSystemTime(Date.now() + seconds * 1000);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-16T12:00:00Z') });
});

afterAll(() => {
  vi.useRealTimers();
});

const requestReset = (service: Service, email: string, ip: string) =>
  send(service.publicUrl, RESET, { ip, body: { email } });

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text() };
}

describe('reset requests', () => {
  let service: Service;

  beforeAll(async () => {
    service = await startService();
    expect((await signUp(service, 'reset-me@example.com')).status).toBe(200);
    expect((await signUp(service, 'reset-two@example.com')).status).toBe(200);
  });

  afterAll(async () => {
    await service?.close();
  });

  afterEach(() => {
    advance(3600);
  });

  it(`the per-email cap (${limits.RESET_REQUEST_PER_EMAIL.max}/h) holds across two IPs, known and unknown alike`, async () => {
    for (const [n, email] of ['reset-me@example.com', 'no-such-user@example.com'].entries()) {
      const ips = [`203.0.113.${110 + 2 * n}`, `203.0.113.${111 + 2 * n}`];
      for (let i = 0; i < limits.RESET_REQUEST_PER_EMAIL.max; i++) {
        expect((await requestReset(service, email, ips[i % 2] as string)).status).not.toBe(429);
      }
      const over = await requestReset(service, ` ${email.toUpperCase()} `, `203.0.113.${115 + n}`);
      expect(over.status).toBe(429);
      const row = await rateLimitRow(service, emailKey(email, '/request-password-reset'));
      expect(row?.count).toBe(limits.RESET_REQUEST_PER_EMAIL.max + 1);
    }
  });

  it('an unknown email draws the same response as a known one, at every step', async () => {
    const known: unknown[] = [];
    const unknown: unknown[] = [];
    for (let i = 0; i <= limits.RESET_REQUEST_PER_EMAIL.max; i++) {
      known.push(await snapshot(await requestReset(service, 'reset-two@example.com', '203.0.113.120')));
      unknown.push(await snapshot(await requestReset(service, 'ghost@example.com', '203.0.113.121')));
    }
    expect(unknown).toEqual(known);
  });

  it(`the global ceiling (${limits.RESET_REQUEST_GLOBAL.max}/min) holds across emails and IPs`, async () => {
    for (let i = 0; i < limits.RESET_REQUEST_GLOBAL.max; i++) {
      expect((await requestReset(service, `walker-${i}@example.com`, `203.0.113.${i + 1}`)).status).not.toBe(429);
    }
    expect((await requestReset(service, 'walker-last@example.com', '203.0.114.1')).status).toBe(429);
    expect((await rateLimitRow(service, globalKey('/request-password-reset')))?.count).toBe(
      limits.RESET_REQUEST_GLOBAL.max + 1
    );
    advance(limits.RESET_REQUEST_GLOBAL.window);
    expect((await requestReset(service, 'walker-after@example.com', '203.0.114.2')).status).not.toBe(429);
  });

  it('a request refused by the global ceiling still counts toward the email cap', async () => {
    const email = 'ceiling-victim@example.com';
    await service.client.query(
      `insert into auth.rate_limit (key, count, last_request) values ($1, $2, $3)
       on conflict (key) do update set count = excluded.count, last_request = excluded.last_request`,
      [globalKey('/request-password-reset'), limits.RESET_REQUEST_GLOBAL.max, Date.now()]
    );
    expect((await requestReset(service, email, '203.0.113.161')).status).toBe(429);
    expect((await rateLimitRow(service, emailKey(email, '/request-password-reset')))?.count).toBe(1);
  });

  it('no per-IP row is written for the path, by the router or by apps/auth', async () => {
    await requestReset(service, 'any@example.com', '203.0.113.170');
    const keys = await rateLimitKeys(service);
    expect(keys.filter((k) => k.includes('203.0.113.170'))).toEqual([]);
    expect(service.auth.options.rateLimit?.customRules?.['/request-password-reset']).toBe(false);
  });

  it('no key holds a raw email', async () => {
    const { rows } = await service.client.query<{ key: string }>('select key from auth.rate_limit');
    expect(rows.some((r) => r.key.includes('@'))).toBe(false);
  });
});

describe('reset consume', () => {
  let service: Service;

  beforeAll(async () => {
    service = await startService();
  });

  afterAll(async () => {
    await service?.close();
  });

  it(`the global ceiling (${limits.RESET_CONSUME_GLOBAL.max}/min) holds across IPs, and passes after the window`, async () => {
    advance(3600);
    const consume = (ip: string) =>
      send(service.publicUrl, '/api/auth/reset-password', {
        ip,
        body: { token: 'no-such-token', newPassword: STRONG_PASSWORD },
      });
    for (let i = 0; i < limits.RESET_CONSUME_GLOBAL.max; i++) {
      expect((await consume(`203.0.113.${i + 1}`)).status).not.toBe(429);
    }
    expect((await consume('203.0.114.1')).status).toBe(429);
    advance(limits.RESET_CONSUME_GLOBAL.window);
    expect((await consume('203.0.114.2')).status).not.toBe(429);
    expect(service.auth.options.rateLimit?.customRules?.['/reset-password']).toBe(false);
  });
});

describe('the session -> JWT exchange, per session token', () => {
  let service: Service;

  beforeAll(async () => {
    service = await startService();
  });

  afterAll(async () => {
    await service?.close();
  });

  afterEach(() => {
    advance(3600);
  });

  it(`/token: ${limits.TOKEN_EXCHANGE_PER_SESSION.max} per session pass as a burst; the next is 429; another session is unaffected`, async () => {
    const a = await signUpTokens(service, 'exchange-a@example.com');
    const b = await signUpTokens(service, 'exchange-b@example.com');
    advance(3600); // start a fresh window: signUpTokens itself used /token
    const exchange = (bearer: string) =>
      send(service.publicUrl, '/api/auth/token', { bearer, ip: '192.0.2.20' });
    for (let i = 0; i < limits.TOKEN_EXCHANGE_PER_SESSION.max; i++) {
      expect((await exchange(a.sessionToken)).status).toBe(200);
    }
    expect((await exchange(a.sessionToken)).status).toBe(429);
    expect((await exchange(b.sessionToken)).status).toBe(200);
    const keys = await rateLimitKeys(service);
    expect(keys).toContain(sessionKey(a.sessionToken, '/token'));
    expect(keys.some((k) => k.includes(a.sessionToken) || k.includes('192.0.2.20'))).toBe(false);
  });

  it("the signed form of a session's token (the web client's) spends the same budget", async () => {
    const { sessionToken } = await signUpTokens(service, 'exchange-signed@example.com');
    advance(3600);
    // As better-call's signCookieValue makes it: standard base64, padded, URI-encoded.
    const signed = `${sessionToken}.${createHmac('sha256', AUTH_SECRET).update(sessionToken).digest('base64')}`;
    for (const bearer of [sessionToken, encodeURIComponent(signed)]) {
      expect((await send(service.publicUrl, '/api/auth/token', { bearer })).status).toBe(200);
    }
    expect((await rateLimitRow(service, sessionKey(sessionToken, '/token')))?.count).toBe(2);
  });

  it('a spray of bearers that cannot be session tokens writes no rows (batch 4, A)', async () => {
    advance(3600);
    const before = (await rateLimitKeys(service)).length;
    const garbage = [
      'no-such-session',
      'x'.repeat(31),
      'x'.repeat(33),
      `${'A'.repeat(32)}.${'b'.repeat(43)}`, // signed form, wrong HMAC
      `${'A'.repeat(32)}.short`,
      '%E0%A4%A',
      randomUUID(),
    ];
    for (let i = 0; i < 50; i++) {
      const bearer = garbage[i % garbage.length] as string;
      expect((await send(service.publicUrl, '/api/auth/token', { bearer })).status).toBe(401);
    }
    expect((await rateLimitKeys(service)).length).toBe(before);
  });

  it('sessionTokenOf accepts exactly the two forms better-auth accepts', () => {
    const token = 'Ab3'.repeat(10) + 'Cd';
    const mac = createHmac('sha256', AUTH_SECRET).update(token);
    const raw = mac.digest();
    const sig = raw.toString('base64url');
    const std = raw.toString('base64');
    expect(sessionTokenOf(token, AUTH_SECRET)).toBe(token);
    for (const form of [`${token}.${sig}`, `${token}.${std}`, encodeURIComponent(`${token}.${std}`)]) {
      expect(sessionTokenOf(form, AUTH_SECRET), form).toBe(token);
    }
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    for (const bad of [`${token}.${sig}x`, `${token}.${flipped}`, `${token}x`, `${token}-`, '', `${token}.${sig}.${sig}`]) {
      expect(sessionTokenOf(bad, AUTH_SECRET), bad).toBeNull();
    }
    expect(sessionTokenOf(`${token}.${sig}`, 'another-secret-of-at-least-32-characters')).toBeNull();
  });

  it('/get-session keeps the router\'s per-IP default; the layer never calls it (batch 4, B)', async () => {
    advance(3600);
    expect(service.auth.options.rateLimit?.customRules?.['/get-session']).toBeUndefined();
    const ip = '192.0.2.21';
    for (let i = 0; i < limits.DEFAULT_RULE.max; i++) {
      expect((await send(service.publicUrl, '/api/auth/get-session', { ip })).status).toBe(200);
    }
    expect((await send(service.publicUrl, '/api/auth/get-session', { ip })).status).toBe(429);
  });
});

describe("the layer's view: every call from one IP (R1)", () => {
  // apps/api's /v2/users layer reaches apps/auth anonymously, so every legacy
  // call carries apps/api's egress IP. More than the router's per-IP default,
  // from that one IP, across two users, must draw no 429; the per-email and
  // per-session rules must still trip.
  let service: Service;
  const API_IP = '192.0.2.99';
  const emails = ['layer-a@example.com', 'layer-b@example.com'];

  beforeAll(async () => {
    service = await startService();
    for (const email of emails) expect((await signUp(service, email)).status).toBe(200);
  });

  afterAll(async () => {
    await service?.close();
  });

  it(`${limits.DEFAULT_RULE.max + 1} sign-ins and ${limits.DEFAULT_RULE.max + 1} token exchanges from one IP are never 429`, async () => {
    advance(3600);
    const total = limits.DEFAULT_RULE.max + 1;
    const sessions: string[] = [];
    for (let i = 0; i < total; i++) {
      const res = await signIn(service, emails[i % 2] as string, STRONG_PASSWORD, { ip: API_IP });
      expect(res.status).toBe(200);
      if (i < 2) sessions.push(((await res.json()) as { token: string }).token);
    }
    for (let i = 0; i < total; i++) {
      const bearer = sessions[i % 2] as string;
      expect((await send(service.publicUrl, '/api/auth/token', { bearer, ip: API_IP })).status).toBe(200);
    }
    expect((await rateLimitKeys(service)).filter((k) => k.includes(API_IP))).toEqual([]);
  });

  it('from that same IP, the per-email sign-in lock and the per-session budget still trip', async () => {
    advance(3600);
    const [victim, other] = emails as [string, string];
    for (let i = 0; i < limits.SIGN_IN_PER_EMAIL.max; i++) {
      expect((await signIn(service, victim, 'Wrong-Passw0rd!', { ip: API_IP })).status).toBe(401);
    }
    expect((await signIn(service, victim, STRONG_PASSWORD, { ip: API_IP })).status).toBe(429);
    const ok = await signIn(service, other, STRONG_PASSWORD, { ip: API_IP });
    expect(ok.status).toBe(200);

    const { token } = (await ok.json()) as { token: string };
    for (let i = 0; i < limits.TOKEN_EXCHANGE_PER_SESSION.max; i++) {
      await send(service.publicUrl, '/api/auth/token', { bearer: token, ip: API_IP });
    }
    expect((await send(service.publicUrl, '/api/auth/token', { bearer: token, ip: API_IP })).status).toBe(429);
  });
});

describe('sign-in and sign-up per email (scenario 32)', () => {
  let service: Service;
  const alerts: ListWalkAlert[] = [];
  const victim = 'victim@example.com';
  const wrong = 'Wrong-Passw0rd!';
  const rule = limits.SIGN_IN_PER_EMAIL;

  beforeAll(async () => {
    service = await startService({ alert: (a) => alerts.push(a) });
    expect((await signUp(service, victim)).status).toBe(200);
    expect((await signUp(service, 'steady@example.com')).status).toBe(200);
  });

  afterAll(async () => {
    await service?.close();
  });

  afterEach(() => {
    advance(3600);
  });

  it(`${rule.max} wrong passwords, then the right one: 429; after the window it succeeds`, async () => {
    // Each attempt from a different IP: the lock is per email, not per IP.
    for (let i = 0; i < rule.max; i++) {
      expect((await signIn(service, victim, wrong)).status).toBe(401);
    }
    const walkKey = `walk:${emailHash(victim)}`;
    const walkAtLock = (await rateLimitRow(service, walkKey))?.last_request;
    expect(walkAtLock).toBeDefined();
    expect((await signIn(service, victim, STRONG_PASSWORD)).status).toBe(429);
    advance(30);
    // A refused attempt is not counted, so it cannot extend the lock, and it
    // writes no list-walk row: the lock's engaging failure already did.
    expect((await signIn(service, victim, wrong)).status).toBe(429);
    expect((await rateLimitRow(service, emailKey(victim, '/sign-in/email')))?.count).toBe(rule.max);
    expect((await rateLimitRow(service, walkKey))?.last_request).toBe(walkAtLock);
    advance(rule.window - 30);
    expect((await signIn(service, victim, STRONG_PASSWORD)).status).toBe(200);
  });

  it('ten correct sign-ins in a row, from one IP, are never limited', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await signIn(service, 'steady@example.com', STRONG_PASSWORD, { ip: '203.0.113.140' })).status).toBe(200);
    }
    expect(await rateLimitRow(service, emailKey('steady@example.com', '/sign-in/email'))).toBeUndefined();
  });

  it('many failures from one IP for different emails are not a global cap', async () => {
    for (let i = 0; i < limits.SIGN_IN_PER_EMAIL.max * 2; i++) {
      expect((await signIn(service, `spread-${i}@example.com`, wrong, { ip: '203.0.113.141' })).status).toBe(401);
    }
  });

  it(`sign-up: ${limits.SIGN_UP_PER_EMAIL.max} per email, every request counted`, async () => {
    for (let i = 0; i < limits.SIGN_UP_PER_EMAIL.max; i++) {
      expect((await signUp(service, 'dup@example.com')).status).not.toBe(429);
    }
    expect((await signUp(service, 'dup@example.com')).status).toBe(429);
  });

  it(`sign-up: the global ceiling (${limits.SIGN_UP_GLOBAL.max}/min) holds across emails and IPs`, async () => {
    // Too-short passwords fail fast and still count: the ceiling counts every
    // request. `send`, not the signUp helper, which clears the ceiling.
    await clearSignUpCeiling(service);
    const attempt = (email: string, password: string) =>
      send(service.publicUrl, '/api/auth/sign-up/email', { body: { email, password, name: 'X' } });
    for (let i = 0; i < limits.SIGN_UP_GLOBAL.max; i++) {
      expect((await attempt(`ceiling-${i}@example.com`, 'short')).status).toBe(400);
    }
    expect((await attempt('ceiling-over@example.com', STRONG_PASSWORD)).status).toBe(429);
  });

  it(`the list-walk alert fires once at ${limits.LIST_WALK_ALERT.distinctEmails} distinct emails, with no raw email`, async () => {
    const threshold = limits.LIST_WALK_ALERT.distinctEmails;
    alerts.length = 0;
    const walked = Array.from({ length: threshold + 2 }, (_, i) => `walked-${i}@example.com`);
    for (const [i, email] of walked.entries()) {
      for (let n = 0; n < rule.max; n++) await signIn(service, email, wrong);
      expect(alerts.length).toBe(i + 1 < threshold ? 0 : 1);
    }
    const [alert] = alerts;
    expect(alert?.distinctEmails).toBe(threshold);
    expect(alert?.windowSeconds).toBe(limits.LIST_WALK_ALERT.window);
    expect(alert?.hashPrefixes).toHaveLength(threshold);
    for (const prefix of alert?.hashPrefixes ?? []) expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(walked.map((e) => emailHash(e).slice(0, 8))).toEqual(expect.arrayContaining(alert?.hashPrefixes ?? []));
    expect(JSON.stringify(alert)).not.toMatch(/@|walked/);
  });
});

describe('the failed-sign-in alert (batch 5, H): an alert, never a cap', () => {
  let service: Service;
  const fired: FailedSignInAlert[] = [];

  beforeAll(async () => {
    service = await startService({ failedSignInAlert: (a) => fired.push(a) });
  });

  afterAll(async () => {
    await service?.close();
  });

  it(`a spray of one failure per email fires once at ${limits.SIGN_IN_FAILED_ALERT.max} and refuses nothing`, async () => {
    advance(3600);
    fired.length = 0;
    const { max, window } = limits.SIGN_IN_FAILED_ALERT;
    const sprayed = Array.from({ length: max + 10 }, (_, i) => `spray-${i}@example.com`);
    for (const [i, email] of sprayed.entries()) {
      // One failure per email: no per-email lock ever engages.
      expect((await signIn(service, email, 'Wrong-Passw0rd!', { ip: '192.0.2.40' })).status).toBe(401);
      expect(fired.length).toBe(i + 1 < max ? 0 : 1);
    }
    const [alert] = fired;
    expect(alert).toMatchObject({ failedSignIns: max, windowSeconds: window, perMinute: max, distinctEmails: max });
    expect(alert?.hashPrefixes.length).toBeGreaterThan(0);
    for (const prefix of alert?.hashPrefixes ?? []) expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(sprayed.map((e) => emailHash(e).slice(0, 8))).toEqual(expect.arrayContaining(alert?.hashPrefixes ?? []));
    expect(JSON.stringify(alert)).not.toMatch(/@|spray/);

    // Nothing is refused: a correct password still signs in, from the same IP.
    expect((await signUp(service, 'after-spray@example.com')).status).toBe(200);
    expect((await signIn(service, 'after-spray@example.com', STRONG_PASSWORD, { ip: '192.0.2.40' })).status).toBe(200);

    // The next window can alert again.
    advance(window);
    for (let i = 0; i < max; i++) await signIn(service, `spray-next-${i}@example.com`, 'Wrong-Passw0rd!');
    expect(fired).toHaveLength(2);
  });

  it('correct sign-ins are never counted', async () => {
    advance(3600);
    fired.length = 0;
    expect((await signUp(service, 'steady-alert@example.com')).status).toBe(200);
    for (let i = 0; i < limits.SIGN_IN_FAILED_ALERT.max + 5; i++) {
      expect((await signIn(service, 'steady-alert@example.com', STRONG_PASSWORD)).status).toBe(200);
    }
    expect(fired).toEqual([]);
  });
});

describe('the list-walk alert through Sentry', () => {
  let service: Service;
  const envelopes: unknown[] = [];

  beforeAll(async () => {
    Sentry.init({
      dsn: 'https://public@o0.ingest.sentry.io/0',
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
    service = await startService();
  });

  afterAll(async () => {
    await Sentry.close();
    await service?.close();
  });

  it('a Sentry transport spy sees one event with counts and hash prefixes, and no email', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now();
    const threshold = limits.LIST_WALK_ALERT.distinctEmails;
    for (let i = 0; i < threshold - 1; i++) {
      await touchKey(service.db, `walk:${emailHash(`seeded-${i}@example.com`)}`, now);
    }
    const email = 'Final.Walker@Example.com';
    for (let n = 0; n < limits.SIGN_IN_PER_EMAIL.max; n++) {
      await signIn(service, email, 'Wrong-Passw0rd!');
    }
    await Sentry.flush(2000);

    const serialized = JSON.stringify(envelopes);
    expect(envelopes).toHaveLength(1);
    expect(serialized).toContain(LIST_WALK_MESSAGE);
    expect(serialized).toContain(emailHash(email).slice(0, 8));
    for (const leak of [email, email.toLowerCase(), 'final.walker', 'example.com', 'seeded-']) {
      expect(serialized.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    const ours = warn.mock.calls.filter((call) => call[0] === LIST_WALK_MESSAGE);
    expect(ours).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@|walker|seeded/i);
    warn.mockRestore();
  });
});
