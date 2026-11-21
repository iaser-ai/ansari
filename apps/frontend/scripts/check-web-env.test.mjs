import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkWebEnv } from './check-web-env.mjs';

const STAGING = {
  EXPO_PUBLIC_API_URL: 'https://api-staging.askansari.ai',
  EXPO_PUBLIC_AUTH_URL: 'https://auth-staging.askansari.ai',
};
const PRODUCTION = {
  EXPO_PUBLIC_API_URL: 'https://api.askansari.ai',
  EXPO_PUBLIC_AUTH_URL: 'https://auth.askansari.ai',
};

describe('checkWebEnv', () => {
  it('passes both staging values', () => {
    expect(checkWebEnv(STAGING)).toEqual([]);
  });

  it('passes both production values, with or without a trailing slash', () => {
    expect(checkWebEnv(PRODUCTION)).toEqual([]);
    expect(
      checkWebEnv({
        EXPO_PUBLIC_API_URL: 'https://api.askansari.ai/',
        EXPO_PUBLIC_AUTH_URL: 'https://auth.askansari.ai/',
      }),
    ).toEqual([]);
  });

  it('passes a local pair (neither is production)', () => {
    expect(
      checkWebEnv({
        EXPO_PUBLIC_API_URL: 'http://localhost:8000',
        EXPO_PUBLIC_AUTH_URL: 'http://localhost:3001',
      }),
    ).toEqual([]);
  });

  it.each(['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_AUTH_URL'])(
    'fails when %s is unset, naming it',
    (name) => {
      for (const base of [STAGING, PRODUCTION]) {
        const env = { ...base };
        delete env[name];
        const errors = checkWebEnv(env);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(new RegExp(`^${name} is unset or empty`));
      }
    },
  );

  it.each(['', '   '])('fails when a value is empty (%j)', (empty) => {
    const errors = checkWebEnv({ ...STAGING, EXPO_PUBLIC_AUTH_URL: empty });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^EXPO_PUBLIC_AUTH_URL is unset or empty/);
  });

  it('names both variables when both are unset', () => {
    const errors = checkWebEnv({});
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^EXPO_PUBLIC_API_URL/);
    expect(errors[1]).toMatch(/^EXPO_PUBLIC_AUTH_URL/);
  });

  it('fails a value that is not a URL', () => {
    const errors = checkWebEnv({ ...PRODUCTION, EXPO_PUBLIC_API_URL: 'api.askansari.ai' });
    expect(errors).toEqual(['EXPO_PUBLIC_API_URL is not a URL: "api.askansari.ai"']);
  });

  it('fails production api with staging auth, showing both values', () => {
    const errors = checkWebEnv({
      EXPO_PUBLIC_API_URL: PRODUCTION.EXPO_PUBLIC_API_URL,
      EXPO_PUBLIC_AUTH_URL: STAGING.EXPO_PUBLIC_AUTH_URL,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('name different environments');
    expect(errors[0]).toContain('EXPO_PUBLIC_API_URL=https://api.askansari.ai');
    expect(errors[0]).toContain('EXPO_PUBLIC_AUTH_URL=https://auth-staging.askansari.ai');
  });

  it('fails staging api with production auth, showing both values', () => {
    const errors = checkWebEnv({
      EXPO_PUBLIC_API_URL: STAGING.EXPO_PUBLIC_API_URL,
      EXPO_PUBLIC_AUTH_URL: PRODUCTION.EXPO_PUBLIC_AUTH_URL,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('EXPO_PUBLIC_API_URL=https://api-staging.askansari.ai');
    expect(errors[0]).toContain('EXPO_PUBLIC_AUTH_URL=https://auth.askansari.ai');
  });

  it('does not take a lookalike host for the production one', () => {
    const errors = checkWebEnv({
      EXPO_PUBLIC_API_URL: 'https://api.askansari.ai.example.com',
      EXPO_PUBLIC_AUTH_URL: PRODUCTION.EXPO_PUBLIC_AUTH_URL,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('name different environments');
  });
});

describe('check-web-env CLI', () => {
  const script = fileURLToPath(new URL('./check-web-env.mjs', import.meta.url));
  const run = (env) =>
    spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    });

  it('exits 1 and names the variable when one is missing', () => {
    const result = run({ EXPO_PUBLIC_API_URL: PRODUCTION.EXPO_PUBLIC_API_URL });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check-web-env: EXPO_PUBLIC_AUTH_URL is unset or empty');
  });

  it('exits 0 for a matching pair', () => {
    const result = run(PRODUCTION);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-web-env: ok');
  });
});
