import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Same reason as packages/auth: every file cold-starts a pglite database
    // and applies the auth journal in `beforeAll`, which can cross vitest's
    // 10 s default under the root `turbo run test`. A hang still fails, at 30 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
