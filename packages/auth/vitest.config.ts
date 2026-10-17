import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Same reason as apps/api (issues #292/#290): every file cold-starts a
    // pglite WASM database and applies the auth journal in `beforeAll`, and the
    // credential suites hash with real bcrypt (cost 12). Under the root
    // `turbo run test`, alongside the api and frontend suites, those hooks
    // crossed vitest's 10 s default and whole files went red; alone they finish
    // in well under it. A hang still fails, at 30 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
