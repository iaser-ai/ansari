// ESM (.mjs): this package has no `"type": "module"`, so a .js file here would be
// treated as CommonJS and could not import @ansari/eslint-config, which is ESM-only.
// NOTE the explicit `.js`. `eslint-config-expo/flat` is a DIRECTORY; CommonJS
// require() resolves it via index.js, but ESM import does not
// (ERR_UNSUPPORTED_DIR_IMPORT). This is the concrete cost of the .js -> .mjs
// conversion, and it fails loudly rather than silently.
import expoConfig from 'eslint-config-expo/flat.js';
import ansari from '@ansari/eslint-config/base';

export default [
  ...ansari,
  ...expoConfig,
  {
    // App-specific ignores; the shared base covers node_modules/dist/.expo.
    ignores: ['expo-env.d.ts', 'uniwind-types.d.ts'],
  },
];
