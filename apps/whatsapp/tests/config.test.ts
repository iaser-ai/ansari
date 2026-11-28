/**
 * Config rules.
 *
 * Python tests ported: test_bsuid_auth_flow.py (mock flags and MOCK_AUTH_TOKEN refused outside
 * development, META_REPLY_BY_PHONE off by default and refused in production) and
 * test_environment_behaviour.py (app secret required, log level defaults).
 *
 * `buildConfig(env)` takes the environment as an object, so no test touches `process.env`
 * (the Python tests patched `os.environ` and cleared an `lru_cache` around every case).
 * `getEnv`/`resetEnvCache` are named like apps/api's.
 */
import { describe, expect, it } from 'vitest';
import { buildConfig, getEnv, MOCK_FLAGS, resetEnvCache, Secret } from '../src/config';

/** The smallest valid environment: every variable without a default. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    ENVIRONMENT: 'development',
    AUTH_WHATSAPP_API_KEY: 'test-key',
    META_BUSINESS_PHONE_NUMBER_ID: '123456',
    META_ACCESS_TOKEN_FROM_SYS_USER: 'test-token',
    META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
    META_ANSARI_APP_SECRET: 'test-secret',
  };
  return { ...base, ...overrides };
}

describe('defaults', () => {
  it('uses the documented defaults', () => {
    const cfg = buildConfig(env());
    expect(cfg.BACKEND_SERVER_URL).toBe('http://localhost:3000');
    expect(cfg.AUTH_SERVER_URL).toBe('http://localhost:3100');
    expect(cfg.META_API_VERSION).toBe('v26.0');
    expect(cfg.WHATSAPP_CHAT_RETENTION_HOURS).toBe(3);
    expect(cfg.WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS).toBe(86400);
    expect(cfg.ALWAYS_RETURN_OK_TO_META).toBe(true);
    expect(cfg.WA_MAINTENANCE_MODE).toBe(false);
    expect(cfg.PORT).toBe(3200);
  });

  it('builds the Meta send URL from the version and the phone number id', () => {
    expect(buildConfig(env()).META_API_URL).toBe('https://graph.facebook.com/v26.0/123456/messages');
  });
});

describe('WHATSAPP_CHAT_RETENTION_HOURS (the default chat expiry)', () => {
  it.each(['0', '24'])('accepts %s, the whole range apps/api accepts', (hours) => {
    expect(buildConfig(env({ WHATSAPP_CHAT_RETENTION_HOURS: hours })).WHATSAPP_CHAT_RETENTION_HOURS).toBe(Number(hours));
  });

  it.each(['25', '-1', '2.5'])('refuses %s, which apps/api would refuse for every message', (hours) => {
    expect(() => buildConfig(env({ WHATSAPP_CHAT_RETENTION_HOURS: hours }))).toThrow(/WHATSAPP_CHAT_RETENTION_HOURS/);
  });
});
describe('booleans', () => {
  it('reads "False" as false (a plain string check would call it true)', () => {
    expect(buildConfig(env({ WA_MAINTENANCE_MODE: 'False' })).WA_MAINTENANCE_MODE).toBe(false);
  });

  it.each(['True', 'true', '1'])('reads %s as true', (value) => {
    expect(buildConfig(env({ WA_MAINTENANCE_MODE: value })).WA_MAINTENANCE_MODE).toBe(true);
  });

  it.each(['False', 'false', '0'])('reads %s as false', (value) => {
    expect(buildConfig(env({ WA_MAINTENANCE_MODE: value })).WA_MAINTENANCE_MODE).toBe(false);
  });

  // Pydantic accepted these; apps/api's switches do not, and neither does this service.
  it.each(['yes', 'on', 'TRUE', 'maybe', ''])('refuses "%s" instead of guessing', (value) => {
    expect(() => buildConfig(env({ WA_MAINTENANCE_MODE: value }))).toThrow(/WA_MAINTENANCE_MODE/);
  });

  it('ALWAYS_RETURN_OK_TO_META is on unless set to false', () => {
    expect(buildConfig(env()).ALWAYS_RETURN_OK_TO_META).toBe(true);
    expect(buildConfig(env({ ALWAYS_RETURN_OK_TO_META: 'False' })).ALWAYS_RETURN_OK_TO_META).toBe(false);
  });
});

describe('required settings', () => {
  it.each(['development', 'staging', 'production'])('fails without the app secret (%s)', (environment) => {
    expect(() => buildConfig(env({ ENVIRONMENT: environment, META_ANSARI_APP_SECRET: undefined }))).toThrow(
      /META_ANSARI_APP_SECRET/,
    );
  });

  it('names every bad variable in one error, whatever order they are listed in', () => {
    const message = (() => {
      try {
        buildConfig({ ENVIRONMENT: 'moon' });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    for (const name of ['ENVIRONMENT', 'AUTH_WHATSAPP_API_KEY', 'META_ANSARI_APP_SECRET']) {
      expect(message).toContain(name);
    }
  });
});

describe('secrets', () => {
  it('never prints a secret, however it is logged', () => {
    const cfg = buildConfig(env({ META_ANSARI_APP_SECRET: 'super-secret-value' }));
    expect(cfg.META_ANSARI_APP_SECRET).toBeInstanceOf(Secret);
    expect(String(cfg.META_ANSARI_APP_SECRET)).not.toContain('super-secret-value');
    expect(`${cfg.META_ANSARI_APP_SECRET}`).not.toContain('super-secret-value');
    expect(JSON.stringify(cfg)).not.toContain('super-secret-value');
  });

  it('reveals the value only on request', () => {
    expect(buildConfig(env({ META_ANSARI_APP_SECRET: 'super-secret-value' })).META_ANSARI_APP_SECRET.reveal()).toBe(
      'super-secret-value',
    );
  });
});

describe('ENVIRONMENT (renamed from DEPLOYMENT_TYPE, issue #363)', () => {
  it.each(['development', 'staging', 'production'])('accepts %s', (environment) => {
    expect(buildConfig(env({ ENVIRONMENT: environment })).ENVIRONMENT).toBe(environment);
  });

  it('refuses "local": it is not a value any more and has no alias', () => {
    expect(() => buildConfig(env({ ENVIRONMENT: 'local' }))).toThrow(/ENVIRONMENT/);
  });

  it('is required', () => {
    expect(() => buildConfig(env({ ENVIRONMENT: undefined }))).toThrow(/ENVIRONMENT/);
    expect(() => buildConfig(env({ ENVIRONMENT: '' }))).toThrow(/ENVIRONMENT/);
  });

  it('is not filled in from the old DEPLOYMENT_TYPE', () => {
    expect(() => buildConfig(env({ ENVIRONMENT: undefined, DEPLOYMENT_TYPE: 'development' }))).toThrow(/ENVIRONMENT/);
    // And a leftover old variable beside the new one is simply ignored
    expect(buildConfig(env({ ENVIRONMENT: 'production', DEPLOYMENT_TYPE: 'development' })).ENVIRONMENT).toBe('production');
  });
});

describe('mocks are only for development', () => {
  it.each(MOCK_FLAGS)('%s is allowed in development', (flag) => {
    expect(buildConfig(env({ ENVIRONMENT: 'development', [flag]: 'True' }))[flag]).toBe(true);
  });

  it.each(MOCK_FLAGS.flatMap((flag) => ['staging', 'production'].map((type) => [flag, type] as const)))(
    '%s is refused when ENVIRONMENT=%s',
    (flag, environment) => {
      expect(() => buildConfig(env({ ENVIRONMENT: environment, [flag]: 'True' }))).toThrow(new RegExp(flag));
    },
  );

  it.each([
    ['development', true],
    ['staging', false],
    ['production', false],
  ] as const)('a shared mock token in %s is allowed: %s', (environment, allowed) => {
    const attempt = () => buildConfig(env({ ENVIRONMENT: environment, MOCK_AUTH_TOKEN: 'a.real.jwt' }));
    if (allowed) {
      expect(attempt().MOCK_AUTH_TOKEN?.reveal()).toBe('a.real.jwt');
    } else {
      expect(attempt).toThrow(/MOCK_AUTH_TOKEN/);
    }
  });

  it('an empty mock token is fine in any environment', () => {
    expect(buildConfig(env({ ENVIRONMENT: 'production', MOCK_AUTH_TOKEN: '' })).ENVIRONMENT).toBe('production');
  });
});

describe('META_REPLY_BY_PHONE', () => {
  it('defaults to off', () => {
    expect(buildConfig(env()).META_REPLY_BY_PHONE).toBe(false);
  });

  it.each(['development', 'staging'])('is allowed in %s', (environment) => {
    expect(buildConfig(env({ ENVIRONMENT: environment, META_REPLY_BY_PHONE: 'True' })).META_REPLY_BY_PHONE).toBe(true);
  });

  it('is refused in production', () => {
    expect(() => buildConfig(env({ ENVIRONMENT: 'production', META_REPLY_BY_PHONE: 'True' }))).toThrow(
      /META_REPLY_BY_PHONE is not allowed when ENVIRONMENT=production/,
    );
  });
});

describe('log level', () => {
  it.each([
    ['development', 'DEBUG'],
    ['staging', 'INFO'],
    ['production', 'INFO'],
  ])('defaults to the right level in %s', (environment, expected) => {
    expect(buildConfig(env({ ENVIRONMENT: environment })).LOGGING_LEVEL).toBe(expected);
  });

  it('an explicit level wins', () => {
    expect(buildConfig(env({ LOGGING_LEVEL: 'WARNING' })).LOGGING_LEVEL).toBe('WARNING');
  });
});

describe('ORIGINS', () => {
  it('always allows the backend, the CI test server and WhatsApp Web', () => {
    expect(buildConfig(env()).ORIGINS).toEqual(['http://localhost:3000', 'testserver', 'https://web.whatsapp.com']);
  });

  it('keeps configured origins first and does not repeat one', () => {
    const cfg = buildConfig(env({ ORIGINS: '"https://api.ansari.chat, https://web.whatsapp.com"' }));
    expect(cfg.ORIGINS).toEqual(['https://api.ansari.chat', 'https://web.whatsapp.com', 'http://localhost:3000', 'testserver']);
  });
});

describe('MAINTENANCE_MODE is not this service\'s switch', () => {
  it('ignores the variable apps/api uses', () => {
    expect(buildConfig(env({ MAINTENANCE_MODE: 'true' })).WA_MAINTENANCE_MODE).toBe(false);
  });
});

describe('getEnv cache', () => {
  it('validates the real environment once and can be reset', () => {
    resetEnvCache();
    const saved = { ...process.env };
    Object.assign(process.env, env());
    try {
      const first = getEnv();
      expect(getEnv()).toBe(first);
      resetEnvCache();
      expect(getEnv()).not.toBe(first);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      resetEnvCache();
    }
  });
});
