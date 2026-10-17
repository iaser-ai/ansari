import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnv, resetEnvCache, config } from '@/lib/config';

// Phase 1 (config centralization): these tests exercise the real env schema in
// lib/config.ts. Because getEnv() memoizes the first successful parse, each case
// calls resetEnvCache() (a test-only export) so it re-parses process.env.

// A minimal env that satisfies every required var outside production.
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  KALEMAT_API_KEY: 'placeholder-key',
  USUL_API_TOKEN: 'placeholder-token',
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Start from a clean, known-good baseline.
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
  it('accepts a valid environment', () => {
    expect(() => getEnv()).not.toThrow();
  });

  it('carries no legacy auth setting (spec 300): JWT_* and ADMIN_EMAILS left apps/api', () => {
    process.env.ACCESS_TOKEN_EXPIRY_HOURS = '2';
    process.env.ADMIN_EMAILS = 'admin@example.com';
    resetEnvCache();
    const env = getEnv() as Record<string, unknown>;
    for (const name of ['JWT_SECRET', 'ACCESS_TOKEN_EXPIRY_HOURS', 'REFRESH_TOKEN_EXPIRY_HOURS', 'ADMIN_EMAILS']) {
      expect(env, name).not.toHaveProperty(name);
    }
    expect(config).not.toHaveProperty('auth');
    expect(config).not.toHaveProperty('admin');
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
    process.env.INKLING_MAX_TOKENS = '1';
    expect(() => getEnv()).not.toThrow(); // still cached
    // After a reset, the corrupted env is re-parsed and rejected.
    resetEnvCache();
    expect(() => getEnv()).toThrow(/8192-32768 window/);
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

// Spec 300 phase 7: apps/auth's coordinates. Optional so suites that never
// reach apps/auth run without them; required in production; `config.authService`
// refuses to hand out a partial set.
describe('apps/auth config', () => {
  const AUTH_ENV: Record<string, string> = {
    AUTH_URL: 'https://auth.askansari.ai',
    AUTH_JWT_ISSUER: 'https://issuer.askansari.example',
    AUTH_JWT_AUDIENCE: 'ansari-api',
    AUTH_LAYER_ORIGIN: 'https://api.askansari.ai',
  };
  const setAuthEnv = (overrides: Record<string, string | undefined> = {}) => {
    for (const [k, v] of Object.entries({ ...AUTH_ENV, ...overrides })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  };

  it('exposes the four values through config.authService, the issuer separate from the URL', () => {
    setAuthEnv();
    expect(config.authService).toEqual({
      url: AUTH_ENV.AUTH_URL,
      jwtIssuer: AUTH_ENV.AUTH_JWT_ISSUER,
      jwtAudience: AUTH_ENV.AUTH_JWT_AUDIENCE,
      layerOrigin: 'https://api.askansari.ai',
    });
  });

  it('declares no shared secret or internal URL (owner amendment 2026-10-17)', () => {
    setAuthEnv({ AUTH_INTERNAL_SECRET: 's'.repeat(32), AUTH_INTERNAL_URL: 'http://auth.internal:3101' });
    const env = getEnv() as Record<string, unknown>;
    expect(env.AUTH_INTERNAL_SECRET).toBeUndefined();
    expect(env.AUTH_INTERNAL_URL).toBeUndefined();
    expect(Object.keys(config.authService).sort()).toEqual(['jwtAudience', 'jwtIssuer', 'layerOrigin', 'url']);
    setAuthEnv({ AUTH_INTERNAL_SECRET: undefined, AUTH_INTERNAL_URL: undefined });
  });

  it('outside production the env parses without them, and authService names what is missing', () => {
    setAuthEnv({ AUTH_URL: undefined, AUTH_LAYER_ORIGIN: undefined });
    expect(() => getEnv()).not.toThrow();
    expect(() => config.authService).toThrow(
      'apps/auth is not configured: set AUTH_URL, AUTH_LAYER_ORIGIN.'
    );
  });

  it('in production each one is required', () => {
    for (const name of Object.keys(AUTH_ENV)) {
      setAuthEnv({ [name]: undefined });
      process.env.NODE_ENV = 'production';
      resetEnvCache();
      expect(() => getEnv()).toThrow(`${name} is required in production`);
    }
    setAuthEnv();
    process.env.NODE_ENV = 'production';
    resetEnvCache();
    expect(() => getEnv()).not.toThrow();
  });

  it('rejects a non-URL issuer or auth URL', () => {
    setAuthEnv({ AUTH_JWT_ISSUER: 'auth.askansari.ai' });
    expect(() => getEnv()).toThrow(/AUTH_JWT_ISSUER must be a valid URL/);
    setAuthEnv({ AUTH_JWT_ISSUER: AUTH_ENV.AUTH_JWT_ISSUER, AUTH_URL: 'auth.askansari.ai' });
    expect(() => getEnv()).toThrow(/AUTH_URL must be a valid URL/);
  });

  it('never puts a value in the error', () => {
    setAuthEnv({ AUTH_URL: 'not-a-url-but-a-value' });
    expect(() => getEnv()).toThrow();
    try {
      getEnv();
    } catch (err) {
      expect(String(err)).not.toContain('not-a-url-but-a-value');
    }
  });
});
