import { defineConfig } from 'vitest/config';
import path from 'path';

const api = (dir: string) => path.resolve(__dirname, '../api', dir);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // tests/run-command.test.ts starts tsx, a cold start that can cross
    // vitest's 5 s default on a loaded machine. A hang still fails, at 30 s.
    testTimeout: 30_000,
  },
  resolve: {
    // `@/` is apps/api's alias (see tsconfig.json), in the same order as
    // apps/api/vitest.config.ts: the specific prefixes before the bare one.
    alias: [
      { find: '@/lib', replacement: api('lib') },
      { find: '@/db', replacement: api('db') },
      { find: '@', replacement: api('src') },
    ],
  },
});
