// ENVIRONMENT (#314 Amendment 3, owner 2026-11-12): the deployment label, the
// Sentry environment and the service-key prefix's environment. Under
// NODE_ENV=production it is required and must be staging or production, so a
// deployed apps/auth without it refuses to boot (src/index.ts calls getEnv()
// before anything else) and names the variable, never a value. Outside
// production it defaults to development. Nothing reads it at build time: the
// image build runs tsc/tsdown, which never executes getEnv().
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { envSchema, getEnv, resetEnvCache } from '@ansari/auth/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const COMPLETE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/auth',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'https://auth.example.test',
  CORS_ORIGIN: 'https://app.example.test',
  AUTH_LAYER_ORIGIN: 'https://api.example.test',
  AUTH_JWT_ISSUER: 'https://auth.example.test',
  AUTH_JWT_AUDIENCE: 'ansari-api',
  RESEND_API_KEY: 'r'.repeat(20),
  FRONTEND_URL: 'https://app.example.test',
};

const issuesOf = (env: Record<string, string | undefined>) => {
  const result = envSchema.safeParse(env);
  return result.success ? [] : result.error.issues.map((i) => String(i.path[0]));
};

describe('ENVIRONMENT in the schema', () => {
  it.each([[undefined], ['development'], ['prod'], ['test']])(
    'NODE_ENV=production with ENVIRONMENT %j is refused, on ENVIRONMENT only',
    (environment) => {
      expect(issuesOf({ ...COMPLETE, NODE_ENV: 'production', ENVIRONMENT: environment })).toEqual(['ENVIRONMENT']);
    }
  );

  it.each([['staging'], ['production']])('NODE_ENV=production with ENVIRONMENT=%s parses', (environment) => {
    const result = envSchema.safeParse({ ...COMPLETE, NODE_ENV: 'production', ENVIRONMENT: environment });
    expect(result.success && result.data.ENVIRONMENT).toBe(environment);
  });

  it.each([['development'], ['test'], [undefined]])('NODE_ENV=%s without ENVIRONMENT is development', (nodeEnv) => {
    const result = envSchema.safeParse({ ...COMPLETE, NODE_ENV: nodeEnv });
    expect(result.success && result.data.ENVIRONMENT).toBe('development');
  });
});

describe('the boot path (getEnv, first call in src/index.ts)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    resetEnvCache();
  });
  afterEach(() => {
    process.env = saved;
    resetEnvCache();
  });

  it('refuses a production boot without ENVIRONMENT, naming it and no value', () => {
    process.env = { ...process.env, ...COMPLETE, NODE_ENV: 'production' };
    delete process.env.ENVIRONMENT;
    expect(() => getEnv()).toThrow(/env validation failed for: ENVIRONMENT\./);
    try {
      getEnv();
    } catch (err) {
      expect(String(err)).not.toContain(COMPLETE.BETTER_AUTH_SECRET);
    }
  });

  it('boots with ENVIRONMENT=staging, and the value reaches Sentry init', () => {
    process.env = { ...process.env, ...COMPLETE, NODE_ENV: 'production', ENVIRONMENT: 'staging' };
    expect(getEnv().ENVIRONMENT).toBe('staging');
    const index = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
    expect(index).toContain('initSentry(env.SENTRY_DSN, env.ENVIRONMENT);');
  });
});
