/**
 * The documented run command, started for real: tsx, in this package (issue #397).
 *
 * The harness reaches apps/api through `@/`, and apps/api's own files use `@/` among
 * themselves. tsx takes the alias from this package's tsconfig.json and vitest takes it
 * from vitest.config.ts, so each is proven here. The other suites cannot tell: what they
 * import through `@/` is types, erased before anything is resolved.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE = path.resolve(__dirname, '..');
const tsx = (...args: string[]) =>
  execFileSync(path.join(PACKAGE, 'node_modules/.bin/tsx'), args, { cwd: PACKAGE, encoding: 'utf8' });

/** The api modules run.ts loads for a real run, read from run.ts so the list cannot drift. */
const API_MODULES = [...readFileSync(path.join(PACKAGE, 'run.ts'), 'utf8').matchAll(/import\('(@\/[^']+)'\)/g)].map((m) => m[1]);

describe('the run command (issue #397)', () => {
  it('prints the plan for --dry-run, calling nothing', () => {
    const out = tsx('run.ts', '--models', 'model-a,model-b', '--dry-run');
    expect(out).toContain('Question set facilitator-core v1: 41 questions, 46 turns.');
    expect(out).toContain('Models: model-a, model-b (baseline model-a); 1 sample(s) each.');
    expect(out).toContain('Plan: 82 conversations, 92 facilitator requests');
  });

  it('finds the facilitator among the api modules run.ts loads', () => {
    expect(API_MODULES).toContain('@/lib/facilitator/agent');
    expect(API_MODULES.length).toBeGreaterThanOrEqual(4);
  });

  it('loads every one of them under tsx', () => {
    const script = `Promise.all(${JSON.stringify(API_MODULES)}.map((s) => import(s))).then((m) => console.log('loaded ' + m.length))`;
    expect(tsx('-e', script).trim()).toBe(`loaded ${API_MODULES.length}`);
  });

  it('loads the facilitator under vitest', async () => {
    const agent = await import('@/lib/facilitator/agent');
    expect(typeof agent.runFacilitator).toBe('function');
  });
});
