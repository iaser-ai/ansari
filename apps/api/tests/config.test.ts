import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnv, resetEnvCache, config } from '@/lib/config';

// Phase 1 (config centralization): these tests exercise the real env schema in
// lib/config.ts. Because getEnv() memoizes the first successful parse, each case
// calls resetEnvCache() (a test-only export) so it re-parses process.env.

// A minimal env that satisfies every required var. Expiry vars are intentionally
// left unset so their schema defaults (2 / 2160) apply unless a test overrides.
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  KALEMAT_API_KEY: 'placeholder-key',
  USUL_API_TOKEN: 'placeholder-token',
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Start from a clean, known-good baseline.
  delete process.env.ACCESS_TOKEN_EXPIRY_HOURS;
  delete process.env.REFRESH_TOKEN_EXPIRY_HOURS;
  delete process.env.INKLING_MODEL;
  delete process.env.INKLING_MAX_TOKENS;
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  resetEnvCache();
});

afterEach(() => {
  process.env = savedEnv;
  resetEnvCache();
});

describe('config env validation', () => {
  it('accepts a valid environment and exposes the JWT secret via config.auth', () => {
    expect(() => getEnv()).not.toThrow();
    expect(config.auth.jwtSecret).toBe('x'.repeat(32));
    // Defaults apply when the expiry vars are unset.
    expect(config.auth.accessTokenExpiryHours).toBe(2);
    expect(config.auth.refreshTokenExpiryHours).toBe(2160);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    process.env.JWT_SECRET = 'x'.repeat(31);
    resetEnvCache();
    expect(() => getEnv()).toThrow(/at least 32 characters/);
  });

  it('rejects an empty JWT_SECRET', () => {
    process.env.JWT_SECRET = '';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/Environment validation failed/);
  });

  it('rejects a zero access-token expiry', () => {
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '0';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/greater than 0/);
  });

  it('rejects a negative refresh-token expiry', () => {
    process.env.REFRESH_TOKEN_EXPIRY_HOURS = '-5';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/greater than 0/);
  });

  it('rejects a non-integer access-token expiry', () => {
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '2.5';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/integer/);
  });

  it('accepts a positive integer expiry override', () => {
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '4';
    resetEnvCache();
    expect(getEnv().ACCESS_TOKEN_EXPIRY_HOURS).toBe(4);
  });

  it('rejects a missing required var (DATABASE_URL)', () => {
    delete process.env.DATABASE_URL;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/Environment validation failed/);
  });
});

// Issue #90: Inkling model id and completion cap are env-overridable through
// config, defaulting to the previously hardcoded values. The max_tokens window
// (8192–16384) is enforced at parse — out-of-window values fail loudly, no
// clamping — because a cap below 8K lets Inkling's hidden reasoning pass starve
// the visible answer (see inkling-client.ts header).
describe('config.inkling (issue #90)', () => {
  it('defaults to the previously hardcoded model and max_tokens when unset', () => {
    expect(config.inkling.model).toBe('thinkingmachines/Inkling');
    expect(config.inkling.maxTokens).toBe(8192);
  });

  it('INKLING_MODEL flows through config (tinker:// LoRA id)', () => {
    process.env.INKLING_MODEL =
      'tinker://ac84a01f-1cbb-55b0-80f4-f9f2b6e3df99:train:0/sampler_weights/final';
    resetEnvCache();
    expect(config.inkling.model).toBe(
      'tinker://ac84a01f-1cbb-55b0-80f4-f9f2b6e3df99:train:0/sampler_weights/final'
    );
  });

  it('rejects an empty INKLING_MODEL', () => {
    process.env.INKLING_MODEL = '';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/INKLING_MODEL must not be empty/);
  });

  it('accepts INKLING_MAX_TOKENS at both window edges', () => {
    process.env.INKLING_MAX_TOKENS = '16384';
    resetEnvCache();
    expect(config.inkling.maxTokens).toBe(16384);

    process.env.INKLING_MAX_TOKENS = '8192';
    resetEnvCache();
    expect(config.inkling.maxTokens).toBe(8192);
  });

  it('rejects INKLING_MAX_TOKENS below the window (8191) — fail fast, no clamping', () => {
    process.env.INKLING_MAX_TOKENS = '8191';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/8192-16384/);
  });

  it('rejects INKLING_MAX_TOKENS above the window (16385) — fail fast, no clamping', () => {
    process.env.INKLING_MAX_TOKENS = '16385';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/8192-16384/);
  });

  it('rejects a non-integer INKLING_MAX_TOKENS', () => {
    process.env.INKLING_MAX_TOKENS = '9000.5';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/must be an integer/);
  });
});

describe('resetEnvCache', () => {
  it('re-parses process.env after a reset (memoization is cleared)', () => {
    // First parse succeeds and is memoized.
    expect(() => getEnv()).not.toThrow();
    // Corrupt the env; without a reset the memoized value would still be returned.
    process.env.JWT_SECRET = 'too-short';
    expect(() => getEnv()).not.toThrow(); // still cached
    // After a reset, the corrupted env is re-parsed and rejected.
    resetEnvCache();
    expect(() => getEnv()).toThrow(/at least 32 characters/);
  });
});
