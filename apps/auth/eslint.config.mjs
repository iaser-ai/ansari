import tseslint from 'typescript-eslint';
import ansari from '@ansari/eslint-config/base';

// See packages/types/eslint.config.mjs: the shared base is ignores-only, and
// ESLint 9 flat config needs an explicit `files` glob + TS parser or it lints
// nothing and still reports success.
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
