import { defineConfig } from 'vitest/config';
import base from '../vitest.config';

// Benchmarks live outside the test suite (spec 168): run explicitly with
//   pnpm vitest run --config scripts/vitest.bench.config.ts
// `include` is REPLACED, not merged, so only the benchmarks run.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['scripts/**/*.bench.ts'], testTimeout: 300_000 },
});
