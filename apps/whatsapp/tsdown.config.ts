import { defineConfig } from 'tsdown';

// One bundled ESM file, so `node dist/index.mjs` runs without a TypeScript step.
export default defineConfig({
  entry: './src/index.ts',
  format: 'esm',
  outDir: './dist',
  clean: true,
});
