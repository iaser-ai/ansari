import tseslint from 'typescript-eslint';
import ansari from '@ansari/eslint-config/base';

// Same shape as packages/types: the shared base is ignores-only, and ESLint 9
// flat config does not match `.ts` files without an explicit `files` glob and
// a TypeScript parser, so both are spelled out. `results/` is run output.
export default [
  ...ansari,
  { ignores: ['results/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: false, sourceType: 'module' },
    },
  },
];
