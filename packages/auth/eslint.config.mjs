import tseslint from 'typescript-eslint';
import ansari from '@ansari/eslint-config/base';

// Mirrors packages/types: the shared base is ignores-only, and ESLint 9 flat
// config does NOT match `.ts` files without an explicit `files` glob + a
// TypeScript parser — omit them and `eslint .` silently lints only this config
// file and reports success while checking nothing.
export default [
  ...ansari,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: false, sourceType: 'module' },
    },
  },
];
