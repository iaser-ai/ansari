import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Pin for issue #330: the root `pnpm test` runs every package's vitest suite at
// once under turbo, and each suite defaults to (cores - 1) workers, so a 14-core
// machine ran ~50 forks and pglite setup hooks crossed the 30 s deadline under
// ordinary load. The root script caps each suite's pool instead of raising
// deadlines. This only pins that the cap is there; the real proof is the A/B in
// codev/reviews/330: two root runs started together went red in 5/5 pairs
// without the cap and green in 5/5 with it. The root package.json is in this
// task's turbo inputs, so removing the flag busts the cache and this file runs.

const rootPackageJson = resolve(__dirname, '../../../package.json');

describe('root test script', () => {
  // Exact, not a pattern: 4 is the measured value, and a looser match would
  // pass an ineffective cap (`=64`) or a second flag overriding it.
  it('caps vitest workers at the measured 4', () => {
    const { scripts } = JSON.parse(readFileSync(rootPackageJson, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(scripts.test).toBe('turbo run test --filter=!ansari-mcp -- --maxWorkers=4');
  });
});
