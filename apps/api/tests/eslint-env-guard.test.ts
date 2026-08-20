import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { ESLint } from 'eslint';

// Guard-of-the-guard for the no-restricted-properties rule in eslint.config.mjs
// (issue #17, replaces the grepping auth-config-bypass.test.ts): lints virtual
// files through the real project config and asserts the rule fires tree-wide
// and stays silent in the allowlisted files. If someone deletes or defangs the
// rule, or drops the allowlist, this suite fails.

const backendRoot = resolve(__dirname, '..');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: backendRoot });
});

async function ruleErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: resolve(backendRoot, filePath),
  });
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-properties')
    .map((m) => m.message);
}

describe('no-restricted-properties env guard', () => {
  it.each([
    ['JWT_SECRET', 'lib/auth/hypothetical.ts'],
    ['DATABASE_URL', 'lib/db/hypothetical.ts'],
    ['JWT_SECRET', 'src/app/api/v2/users/login/hypothetical.ts'],
    ['ACCESS_TOKEN_EXPIRY_HOURS', 'lib/auth/hypothetical.ts'],
    ['REFRESH_TOKEN_EXPIRY_HOURS', 'lib/auth/hypothetical.ts'],
  ])('flags process.env.%s in %s', async (envVar, filePath) => {
    const errors = await ruleErrors(`export const v = process.env.${envVar};\n`, filePath);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('lib/config.ts');
  });

  it('flags getEnv() sidesteps outside lib/config.ts', async () => {
    const code = `import { getEnv } from '@/lib/config';\nexport const s = getEnv().JWT_SECRET;\n`;
    const errors = await ruleErrors(code, 'lib/auth/hypothetical.ts');
    expect(errors).toHaveLength(1);
  });

  it.each([
    ['lib/config.ts', 'export const v = process.env.JWT_SECRET;\n'],
    ['drizzle.config.ts', 'export const v = process.env.DATABASE_URL;\n'],
  ])('stays silent in allowlisted %s', async (filePath, code) => {
    const errors = await ruleErrors(code, filePath);
    expect(errors).toHaveLength(0);
  });

  it('the real tree is clean: npm run lint has no such violations', async () => {
    // Lint the actual source tree (not virtual text) so a reintroduced bypass
    // in any existing file fails here even if CI lint were skipped.
    const results = await eslint.lintFiles(['lib/**/*.ts', 'src/**/*.ts', 'src/**/*.tsx']);
    const violations = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-restricted-properties')
        .map((m) => `${r.filePath}:${m.line} ${m.message}`)
    );
    expect(violations).toEqual([]);
  });
});
