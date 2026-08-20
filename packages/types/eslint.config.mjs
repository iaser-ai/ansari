import tseslint from 'typescript-eslint';
import ansari from '@ansari/eslint-config/base';

// The shared base is ignores-only. ESLint 9 flat config does NOT match `.ts`
// files by default, so without an explicit `files` glob AND a TypeScript parser,
// `eslint .` silently lints only this config file and reports success while
// checking nothing. Verified: with `var unused = 1` in src/index.ts, `eslint .`
// exited 0 before this was added.
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
