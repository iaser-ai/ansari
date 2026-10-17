import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  verifyAccessToken,
  JWKS_COOLDOWN_MS,
  JWKS_CACHE_MAX_AGE_MS,
  JWKS_STALE_GRACE_MS,
} from '@/lib/auth/verify-jwt';
import {
  legacyAccessToken,
  newKey,
  setApiEnv,
  signToken,
  startJwksServer,
  TEST_ISSUER,
  type JwksServer,
  type SigningKey,
} from './helpers';

/**
 * apps/api's JWT verifier against a local JWKS handler serving real key pairs
 * (spec 300 scenarios 17, 18, 23, 24 and 33). Nothing in jose is mocked. Time
 * moves through a faked `Date` only, so network timers stay real.
 */

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

let jwks: JwksServer;
let key: SigningKey;

async function warmUp() {
  expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
}

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  key = await newKey();
  jwks = await startJwksServer([key]);
  setApiEnv(jwks.url);
});

afterEach(async () => {
  vi.useRealTimers();
  await jwks.stop();
});

describe('a valid token', () => {
  it('verifies to its sub and sid', async () => {
    const sub = randomUUID();
    const sid = randomUUID();
    expect(await verifyAccessToken(await signToken({ key, sub, sid }))).toEqual({ sub, sid });
  });

  it('fetches the public JWKS like any other client: no credential, no forwarded IP', async () => {
    await warmUp();
    expect(jwks.requests).toBe(1);
    const names = Object.keys(jwks.lastHeaders ?? {});
    expect(names.some((n) => n.startsWith('x-ansari-'))).toBe(false);
    expect(names).not.toContain('authorization');
  });

  it("an issuer that differs from AUTH_URL is pinned as set, never derived from the URL", async () => {
    // AUTH_URL is the JWKS server here; the issuer stays TEST_ISSUER.
    expect(new URL(jwks.url).origin).not.toBe(new URL(TEST_ISSUER).origin);
    await warmUp();
    expect(await verifyAccessToken(await signToken({ key, issuer: jwks.url }))).toBeNull();
  });
});

describe('scenario 23: the rejection matrix', () => {
  // Every case is otherwise a valid token, so only the named defect rejects it.
  // An RS256 key is also published, so the RS256 case reaches the alg pin.
  let rsa: SigningKey;

  beforeEach(async () => {
    rsa = await newKey('RS256');
    jwks.keys.push(rsa);
    await warmUp();
  });

  it('alg none', async () => {
    const token = `${b64url({ alg: 'none', kid: key.kid })}.${b64url({
      sub: randomUUID(),
      sid: randomUUID(),
      iss: 'https://auth.test.example',
      aud: 'ansari-api-test',
      exp: Math.floor(Date.now() / 1000) + 900,
    })}.`;
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('HS256, keyed by the internal secret', async () => {
    const token = await new SignJWT({ sub: randomUUID(), sid: randomUUID() })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid })
      .setIssuer('https://auth.test.example')
      .setAudience('ansari-api-test')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('test-internal-secret-at-least-32-characters'));
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('RS256, with its key published', async () => {
    expect(await verifyAccessToken(await signToken({ key: rsa }))).toBeNull();
  });

  it('a wrong iss', async () => {
    expect(await verifyAccessToken(await signToken({ key, issuer: 'https://evil.example' }))).toBeNull();
  });

  it('a wrong aud', async () => {
    expect(await verifyAccessToken(await signToken({ key, audience: 'another-api' }))).toBeNull();
  });

  it('an expired token', async () => {
    expect(await verifyAccessToken(await signToken({ key, expiresIn: -60 }))).toBeNull();
  });

  it('a bad signature', async () => {
    const [header, , signature] = (await signToken({ key })).split('.');
    const forged = b64url({
      sub: randomUUID(),
      sid: randomUUID(),
      iss: 'https://auth.test.example',
      aud: 'ansari-api-test',
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    expect(await verifyAccessToken(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it('an unknown key', async () => {
    const stranger = await newKey();
    expect(await verifyAccessToken(await signToken({ key: stranger }))).toBeNull();
  });

  it('a legacy HS256 token from today\'s jwt.ts', async () => {
    const legacy = await legacyAccessToken();
    expect(await verifyAccessToken(legacy)).toBeNull();
  });

  it('no exp', async () => {
    expect(await verifyAccessToken(await signToken({ key, expiresIn: null }))).toBeNull();
  });

  it('no sub', async () => {
    expect(await verifyAccessToken(await signToken({ key, sub: null }))).toBeNull();
  });

  it('no sid', async () => {
    expect(await verifyAccessToken(await signToken({ key, sid: null }))).toBeNull();
  });

  it('a sub or sid that is not a string', async () => {
    const claims = { iss: 'https://auth.test.example', aud: 'ansari-api-test' };
    for (const payload of [
      { sub: 42, sid: randomUUID() },
      { sub: randomUUID(), sid: 42 },
    ]) {
      const token = await new SignJWT({ ...payload, ...claims })
        .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
        .setExpirationTime('15m')
        .sign(key.privateKey);
      expect(await verifyAccessToken(token)).toBeNull();
    }
  });

  it('garbage', async () => {
    expect(await verifyAccessToken('not-a-jwt')).toBeNull();
    expect(await verifyAccessToken('')).toBeNull();
  });
});

describe('scenario 24: a flood of random kids', () => {
  it('fetches at most once per cooldown', async () => {
    await warmUp();
    expect(jwks.requests).toBe(1);

    const flood = async () => {
      const tokens = await Promise.all(
        Array.from({ length: 50 }, () => signToken({ key, kid: randomUUID() }))
      );
      const results = await Promise.all(tokens.map((t) => verifyAccessToken(t)));
      expect(results.every((r) => r === null)).toBe(true);
    };

    await flood();
    expect(jwks.requests).toBe(1);

    advance(JWKS_COOLDOWN_MS + 1);
    await flood();
    expect(jwks.requests).toBe(2);

    await flood();
    expect(jwks.requests).toBe(2);
  });

  it('a failing JWKS endpoint is also fetched at most once per cooldown', async () => {
    jwks.failing = true;
    for (let i = 0; i < 20; i++) {
      expect(await verifyAccessToken(await signToken({ key }))).toBeNull();
    }
    expect(jwks.requests).toBe(1);

    advance(JWKS_COOLDOWN_MS + 1);
    jwks.failing = false;
    await warmUp();
    expect(jwks.requests).toBe(2);
  });
});

describe('scenario 17: key rotation', () => {
  it('picks up a new key without a restart, and the old key still verifies', async () => {
    await warmUp();
    const rotated = await newKey();
    jwks.keys.push(rotated);

    advance(JWKS_COOLDOWN_MS + 1);
    expect(await verifyAccessToken(await signToken({ key: rotated }))).not.toBeNull();
    expect(jwks.requests).toBe(2);

    expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
    expect(jwks.requests).toBe(2);
  });
});

describe('scenario 18: apps/auth stopped', () => {
  it('a cached key still verifies', async () => {
    await warmUp();
    await jwks.stop();
    expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
    expect(jwks.requests).toBe(1);
  });

  it('a token issued before the outage verifies until its exp, even past the cache age', async () => {
    await warmUp();
    // Minted just before apps/auth goes down, as late as it can be: 15 minutes.
    advance(JWKS_CACHE_MAX_AGE_MS - 1_000);
    const lastToken = await signToken({ key, expiresIn: 15 * 60 });
    await jwks.stop();

    advance(2_000); // the cache is now stale and the refresh fails
    expect(await verifyAccessToken(lastToken)).not.toBeNull();
    advance(JWKS_STALE_GRACE_MS - 5_000); // just before its exp
    expect(await verifyAccessToken(lastToken)).not.toBeNull();
    expect(jwks.requests).toBe(1);
  });

  it('past the stale grace, verification fails closed', async () => {
    await warmUp();
    await jwks.stop();
    advance(JWKS_CACHE_MAX_AGE_MS + JWKS_STALE_GRACE_MS + 1_000);
    expect(await verifyAccessToken(await signToken({ key }))).toBeNull();
  });

  it('a failing endpoint (5xx) is an outage too: the stale keys keep verifying', async () => {
    await warmUp();
    jwks.failing = true;
    advance(JWKS_CACHE_MAX_AGE_MS + 1_000);
    expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
    expect(jwks.requests).toBe(2);
  });

  it('a failed refresh does not extend the grace', async () => {
    await warmUp();
    jwks.failing = true;
    advance(JWKS_CACHE_MAX_AGE_MS + 1_000);
    expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
    expect(jwks.requests).toBe(2);
    // The grace counts from the last SUCCESSFUL fetch, not the failed one.
    advance(JWKS_STALE_GRACE_MS);
    expect(await verifyAccessToken(await signToken({ key }))).toBeNull();
  });

  it('a 200 with a malformed body is a failed refresh and does not extend the grace', async () => {
    for (const body of ['not json', '{"keys":"x"}', '{"keys":[1]}', 'null']) {
      setApiEnv(jwks.url);
      jwks.malformedBody = null;
      const start = jwks.requests;
      await warmUp();
      jwks.malformedBody = body;
      advance(JWKS_CACHE_MAX_AGE_MS + 1_000);
      expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
      expect(jwks.requests).toBe(start + 2);
      advance(JWKS_STALE_GRACE_MS);
      expect(await verifyAccessToken(await signToken({ key }))).toBeNull();
    }
  });

  it('an unknown kid during an outage is still refused', async () => {
    await warmUp();
    await jwks.stop();
    advance(JWKS_CACHE_MAX_AGE_MS + 1_000);
    expect(await verifyAccessToken(await signToken({ key: await newKey() }))).toBeNull();
  });
});

describe('scenario 33: steady state', () => {
  it('makes no network call after warm-up while the cache is fresh', async () => {
    await warmUp();
    for (let i = 0; i < 100; i++) {
      expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
    }
    advance(JWKS_CACHE_MAX_AGE_MS - 1_000);
    expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
    expect(jwks.requests).toBe(1);

    // Past the cache age, the next verification refreshes once.
    advance(2_000);
    expect(await verifyAccessToken(await signToken({ key }))).not.toBeNull();
    expect(jwks.requests).toBe(2);
  });
});
