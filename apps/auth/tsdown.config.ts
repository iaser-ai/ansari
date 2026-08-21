import { defineConfig } from 'tsdown';

// Bundle the raw-TS workspace deps (@ansari/*) into the output so `node dist`
// runs without pnpm resolving source `.ts` exports at runtime.
export default defineConfig({
  entry: './src/index.ts',
  format: 'esm',
  outDir: './dist',
  clean: true,
  deps: {
    alwaysBundle: [/@ansari\/.*/],
  },
});
