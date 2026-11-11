// apps/api's Sentry environment is ENVIRONMENT (#314 Amendment 3), as apps/auth's
// is (apps/auth/tests/environment.test.ts): never Railway's RAILWAY_ENVIRONMENT
// (owner directive: our own names only) and never NODE_ENV, which is
// `production` on staging too. The file is read as text: it is a side-effect
// module that calls Sentry.init, and boot-check.test.ts mocks it away.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const config = readFileSync(fileURLToPath(new URL('../sentry.server.config.ts', import.meta.url)), 'utf8');
const environmentLine = config.split('\n').find((line) => /^\s*environment\s*:/.test(line));

describe('sentry.server.config.ts environment', () => {
  it('is process.env.ENVIRONMENT', () => {
    expect(environmentLine).toBeDefined();
    expect(environmentLine).toContain('process.env.ENVIRONMENT');
  });

  it('reads neither RAILWAY_* nor NODE_ENV for it', () => {
    expect(environmentLine).not.toMatch(/RAILWAY|NODE_ENV/);
    expect(config).not.toMatch(/RAILWAY/);
  });

  it('the check bites: the pre-#314 line fails it', () => {
    const old = '  environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV,';
    expect(old).toMatch(/RAILWAY|NODE_ENV/);
  });
});
