import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

// ESLint 9 flat config for Next 15. eslint-config-next ships legacy (eslintrc)
// shareable configs, so we bridge them into flat config via FlatCompat — the
// same shape Next 15's own `create-next-app` scaffold generates.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
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
];

export default eslintConfig;
