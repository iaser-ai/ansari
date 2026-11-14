// apps/api's Sentry environment is ENVIRONMENT (#314 Amendment 3), as apps/auth's
// is (apps/auth/tests/environment.test.ts): never Railway's RAILWAY_ENVIRONMENT
// (owner directive: our own names only) and never NODE_ENV, which is
// `production` on staging too. The file is read as text: it is a side-effect
// module that calls Sentry.init, and boot-check.test.ts mocks it away.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const config = readFileSync(fileURLToPath(new URL('../sentry.server.config.ts', import.meta.url)), 'utf8');

/** A READ of a RAILWAY_* variable (a comment naming one is fine). */
const RAILWAY_READ = /process\.env\.RAILWAY_|process\.env\[\s*['"`]RAILWAY_/;

/** The problems with a Sentry server config's environment; empty when it is right. */
function environmentProblems(source: string): string[] {
  const line = source.split('\n').find((l) => /^\s*environment\s*:/.test(l));
  const problems: string[] = [];
  if (line === undefined) return ['no environment line'];
  if (!line.includes('process.env.ENVIRONMENT')) problems.push('environment is not process.env.ENVIRONMENT');
  if (/NODE_ENV/.test(line)) problems.push('environment reads NODE_ENV');
  if (RAILWAY_READ.test(source)) problems.push('reads a RAILWAY_* variable');
  return problems;
}

describe('sentry.server.config.ts environment', () => {
  it('is process.env.ENVIRONMENT, with no NODE_ENV and no RAILWAY_* read', () => {
    expect(environmentProblems(config)).toEqual([]);
  });

  it('the check bites on planted configs, and passes a comment that names the old variable', () => {
    const planted = (environment: string, extra = '') => `Sentry.init({\n${extra}  environment: ${environment},\n});\n`;
    expect(environmentProblems(planted('process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV'))).toEqual([
      'environment is not process.env.ENVIRONMENT',
      'environment reads NODE_ENV',
      'reads a RAILWAY_* variable',
    ]);
    expect(environmentProblems(planted('process.env.NODE_ENV'))).toContain('environment reads NODE_ENV');
    expect(environmentProblems(planted("process.env['RAILWAY_ENVIRONMENT']"))).toContain('reads a RAILWAY_* variable');
    expect(environmentProblems(planted('process.env.ENVIRONMENT', '  // not RAILWAY_ENVIRONMENT (#314)\n'))).toEqual([]);
  });
});
