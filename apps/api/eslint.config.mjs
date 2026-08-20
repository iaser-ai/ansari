import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';
import ansari from '@ansari/eslint-config/base';

// ESLint 9 flat config for Next 15. eslint-config-next ships legacy (eslintrc)
// shareable configs, so we bridge them into flat config via FlatCompat — the
// same shape Next 15's own `create-next-app` scaffold generates.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // Shared build-output/node_modules ignores. The app-specific ignores below
  // (next-env.d.ts, tests/**) stay here — they are not shared.
  ...ansari,
  {
    // Not linted: build output, deps, coverage reports, and the Vitest suite
    // (tests/** is likewise excluded from typecheck in tsconfig.json — kept
    // consistent here rather than pulling ~45 test files into lint scope).
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'next-env.d.ts',
      'tests/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Config-validation bypass guard (issue #17, replaces the grepping
    // tests/auth-config-bypass.test.ts): auth/db secrets must be read through
    // the validated `config` object in lib/config.ts, never process.env.
    // Entries are property-only (no `object:` key) because ESLint matches
    // `object` against a bare identifier and cannot express the nested
    // `process.env.X` chain — as a bonus this also catches `getEnv().X`
    // sidesteps outside the allowlisted files.
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'JWT_SECRET',
          message: 'Read the JWT secret via config.auth.jwtSecret (lib/config.ts), not process.env.',
        },
        {
          property: 'DATABASE_URL',
          message: 'Read the database URL via config.database.url (lib/config.ts), not process.env.',
        },
        {
          property: 'ACCESS_TOKEN_EXPIRY_HOURS',
          message: 'Read token expiry via config.auth.accessTokenExpiryHours (lib/config.ts), not process.env.',
        },
        {
          property: 'REFRESH_TOKEN_EXPIRY_HOURS',
          message: 'Read token expiry via config.auth.refreshTokenExpiryHours (lib/config.ts), not process.env.',
        },
      ],
    },
  },
  {
    // Allowlist: the two files that legitimately read these values raw —
    // lib/config.ts is the validation boundary itself, and drizzle.config.ts
    // runs under drizzle-kit outside the app's config layer.
    files: ['lib/config.ts', 'drizzle.config.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
];

export default eslintConfig;
