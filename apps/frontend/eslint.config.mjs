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
    // `vendor/api-client-react/generated/` is orval output (machine-written,
    // regenerated rather than edited), so it is not hand-lintable.
    ignores: ['expo-env.d.ts', 'uniwind-types.d.ts', 'vendor/api-client-react/generated/**'],
  },
  {
    // Build scripts run under Node, not in the app bundle.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', process: 'readonly' },
    },
  },
  {
    // SCOPED OVERRIDE (#262 -> #264). eslint-config-expo (57, and 58 since
    // #428) ships eslint-plugin-react-hooks v7, whose React Compiler rules flag 26 sites
    // in code ported verbatim from the SDK 54 prototype (which never ran
    // eslint). They mark components the compiler skips optimising, not
    // runtime errors, and each fix restructures a component, which is
    // #264's job, not a verbatim port's. Downgraded to warnings so they stay
    // visible; restore to errors in #264 once fixed.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/globals': 'warn',
    },
  },
];
