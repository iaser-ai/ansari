import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spec 300 phase 9: the admin bootstrap check left apps/api for apps/auth, and
// with it the only thing that read `config` at production boot. The boot env
// check keeps the fail-fast: a production server missing apps/auth's settings
// refuses to start instead of failing its first authenticated request.

const h = vi.hoisted(() => ({ validate: vi.fn() }));

vi.mock('../sentry.server.config', () => ({}));

import { resetEnvCache } from '@/lib/config';
import { shouldValidateEnvAtBoot, validateEnvAtBoot } from '@/lib/boot-check';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  KALEMAT_API_KEY: 'placeholder',
  USUL_API_TOKEN: 'placeholder',
};
const AUTH_ENV = {
  AUTH_URL: 'https://auth.askansari.ai',
  AUTH_JWT_ISSUER: 'https://auth.askansari.ai',
  AUTH_JWT_AUDIENCE: 'ansari-api-boot-check-value',
  AUTH_LAYER_ORIGIN: 'https://api.askansari.ai',
};
const SERVER = { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs' } as const;

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  resetEnvCache();
});
afterEach(() => {
  process.env = saved;
  resetEnvCache();
  vi.doUnmock('@/lib/boot-check');
});

describe('shouldValidateEnvAtBoot', () => {
  it('runs only in a production Node server', () => {
    expect(shouldValidateEnvAtBoot({ ...SERVER })).toBe(true);
  });

  it('does not run during next build, in development or test, or on edge', () => {
    expect(shouldValidateEnvAtBoot({ ...SERVER, NEXT_PHASE: 'phase-production-build' })).toBe(false);
    expect(shouldValidateEnvAtBoot({ ...SERVER, NODE_ENV: 'development' })).toBe(false);
    expect(shouldValidateEnvAtBoot({ ...SERVER, NODE_ENV: 'test' })).toBe(false);
    expect(shouldValidateEnvAtBoot({ ...SERVER, NEXT_RUNTIME: 'edge' })).toBe(false);
  });
});

describe('validateEnvAtBoot', () => {
  it('a production boot missing an apps/auth setting throws, naming it and no value', () => {
    process.env = { ...process.env, ...BASE_ENV, ...AUTH_ENV, ...SERVER };
    delete process.env.AUTH_URL;
    expect(() => validateEnvAtBoot()).toThrow(/AUTH_URL is required in production/);
    try {
      validateEnvAtBoot();
    } catch (err) {
      expect(String(err)).not.toContain(AUTH_ENV.AUTH_JWT_AUDIENCE);
    }
  });

  it('a complete production env boots', () => {
    process.env = { ...process.env, ...BASE_ENV, ...AUTH_ENV, ...SERVER };
    expect(() => validateEnvAtBoot()).not.toThrow();
  });

  it('a build or a dev server never parses the env', () => {
    process.env = { ...process.env, ...SERVER, NEXT_PHASE: 'phase-production-build' };
    delete process.env.DATABASE_URL;
    expect(() => validateEnvAtBoot()).not.toThrow();
    process.env = { ...process.env, NODE_ENV: 'development', NEXT_PHASE: undefined };
    expect(() => validateEnvAtBoot()).not.toThrow();
  });
});

describe('instrumentation', () => {
  it('runs the boot check when the Node server registers', async () => {
    vi.resetModules();
    vi.doMock('@/lib/boot-check', () => ({ validateEnvAtBoot: h.validate }));
    process.env.NEXT_RUNTIME = 'nodejs';
    const { register } = await import('../src/instrumentation');
    await register();
    expect(h.validate).toHaveBeenCalledTimes(1);
  });
});
