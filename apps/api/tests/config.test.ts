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
  delete process.env.INKLING_TIMEOUT_MS;
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

// Issue #90: Inkling model id, completion cap, and timeout are env-overridable
// through config, defaulting to the previously hardcoded values. The max_tokens
// (8192–32768) and timeout (30000–600000) windows are enforced at parse —
// out-of-window values fail loudly, no clamping — because a cap below 8K lets
// Inkling's hidden reasoning pass starve the visible answer (see
// inkling-client.ts header).
describe('config.inkling (issue #90)', () => {
  it('defaults to the previously hardcoded model, max_tokens, and timeout when unset', () => {
    expect(config.inkling.model).toBe('thinkingmachines/Inkling');
    expect(config.inkling.maxTokens).toBe(8192);
    expect(config.inkling.timeoutMs).toBe(180000);
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
    process.env.INKLING_MAX_TOKENS = '32768';
    resetEnvCache();
    expect(config.inkling.maxTokens).toBe(32768);

    process.env.INKLING_MAX_TOKENS = '8192';
    resetEnvCache();
    expect(config.inkling.maxTokens).toBe(8192);
  });

  it('rejects INKLING_MAX_TOKENS below the window (8191) — fail fast, no clamping', () => {
    process.env.INKLING_MAX_TOKENS = '8191';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/8192-32768/);
  });

  it('rejects INKLING_MAX_TOKENS above the window (32769) — fail fast, no clamping', () => {
    process.env.INKLING_MAX_TOKENS = '32769';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/8192-32768/);
  });

  it('rejects a non-integer INKLING_MAX_TOKENS', () => {
    process.env.INKLING_MAX_TOKENS = '9000.5';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/must be an integer/);
  });

  it('INKLING_TIMEOUT_MS flows through config, accepted at both window edges', () => {
    process.env.INKLING_TIMEOUT_MS = '600000';
    resetEnvCache();
    expect(config.inkling.timeoutMs).toBe(600000);

    process.env.INKLING_TIMEOUT_MS = '30000';
    resetEnvCache();
    expect(config.inkling.timeoutMs).toBe(30000);
  });

  it('rejects INKLING_TIMEOUT_MS below the window (29999) — fail fast, no clamping', () => {
    process.env.INKLING_TIMEOUT_MS = '29999';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/30000-600000/);
  });

  it('rejects INKLING_TIMEOUT_MS above the window (600001) — fail fast, no clamping', () => {
    process.env.INKLING_TIMEOUT_MS = '600001';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/30000-600000/);
  });

  it('rejects a non-integer INKLING_TIMEOUT_MS', () => {
    process.env.INKLING_TIMEOUT_MS = '90000.5';
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

describe('primary backend switch (issue #95)', () => {
  beforeEach(() => {
    // The shared beforeEach resets required vars; also start these from unset.
    delete process.env.PRIMARY_BACKEND;
    delete process.env.INKLING_BASE_URL;
    delete process.env.INKLING_API_KEY;
    delete process.env.TINKER_API_KEY;
    resetEnvCache();
  });

  it('defaults are byte-identical to the pre-switch behavior (gemini primary, Tinker URL)', () => {
    expect(config.primaryBackend).toBe('gemini');
    // Pin the default endpoint to the previously hardcoded Tinker URL.
    expect(config.inkling.baseUrl).toBe(
      'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions'
    );
    expect(config.inkling.apiKey).toBeUndefined();
  });

  it('rejects an unknown PRIMARY_BACKEND value', () => {
    process.env.PRIMARY_BACKEND = 'openai';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/Environment validation failed/);
  });

  it('fails fast when PRIMARY_BACKEND=inkling with no API key at all', () => {
    process.env.PRIMARY_BACKEND = 'inkling';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/PRIMARY_BACKEND=inkling requires INKLING_API_KEY/);
  });

  it('accepts PRIMARY_BACKEND=inkling with the TINKER_API_KEY fallback', () => {
    process.env.PRIMARY_BACKEND = 'inkling';
    process.env.TINKER_API_KEY = 'tinker-key';
    resetEnvCache();
    expect(config.primaryBackend).toBe('inkling');
    expect(config.inkling.apiKey).toBe('tinker-key');
  });

  it('INKLING_API_KEY takes precedence over TINKER_API_KEY', () => {
    process.env.INKLING_API_KEY = 'inkling-key';
    process.env.TINKER_API_KEY = 'tinker-key';
    resetEnvCache();
    expect(config.inkling.apiKey).toBe('inkling-key');
  });

  it('rejects an empty INKLING_API_KEY (fail loudly, never a silent unset)', () => {
    process.env.INKLING_API_KEY = '';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/INKLING_API_KEY must not be empty/);
  });

  it('rejects a non-URL INKLING_BASE_URL and honors a valid override', () => {
    process.env.INKLING_BASE_URL = 'not a url';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/INKLING_BASE_URL must be a valid URL/);

    process.env.INKLING_BASE_URL = 'https://example--checkpoint.modal.run/v1/chat/completions';
    resetEnvCache();
    expect(config.inkling.baseUrl).toBe(
      'https://example--checkpoint.modal.run/v1/chat/completions'
    );
  });

  it('rejects plain-http INKLING_BASE_URL (bearer token would travel in cleartext) but allows loopback', () => {
    process.env.INKLING_BASE_URL = 'http://example.com/v1/chat/completions';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/INKLING_BASE_URL must use https/);

    process.env.INKLING_BASE_URL = 'http://localhost:8000/v1/chat/completions';
    resetEnvCache();
    expect(config.inkling.baseUrl).toBe('http://localhost:8000/v1/chat/completions');
  });
});
