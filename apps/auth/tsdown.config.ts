import { defineConfig } from 'tsdown';

// Bundle the raw-TS workspace deps (@ansari/*) into the output so `node dist`
// runs without pnpm resolving source `.ts` exports at runtime. Native modules
// are the exception (see neverBundle).
export default defineConfig({
  entry: './src/index.ts',
  format: 'esm',
  outDir: './dist',
  clean: true,
  deps: {
    alwaysBundle: [/@ansari\/.*/],
    // A native module: its loader resolves the compiled binding next to its
    // own package at runtime, so it must stay an import of node_modules
    // (apps/auth depends on it directly for that reason).
    neverBundle: ['bcrypt'],
  },
});
