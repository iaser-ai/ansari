import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Pin for issue #381: CI runs `test:coverage`, not `test`, and turbo has no way
// to share an `inputs` list between tasks, so apps/api/turbo.json repeats it.
// The two lists drifted (#330, #314, #377 each patched one entry), and every
// file `test` lists but `test:coverage` misses left ansari-api#test:coverage at
// the same hash when only that file changed, so a warm cache replayed a stale
// green doc or scan result. This file is under apps/api, so it is in its own
// task hash: editing either list reruns it.

const turboJson = resolve(__dirname, '../turbo.json');

// turbo.json is JSONC. Strip // and /* */ comments outside strings only: the
// inputs hold globs like "apps/*/src/**", whose `/*` a regex over the whole
// file would take for a block comment.
function stripJsonComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
      i++;
      out += source.slice(start, i);
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

type TurboTask = { inputs?: string[] };

function readTasks(): Record<string, TurboTask> {
  const parsed = JSON.parse(stripJsonComments(readFileSync(turboJson, 'utf8'))) as {
    tasks: Record<string, TurboTask>;
  };
  return parsed.tasks;
}

describe('apps/api turbo inputs', () => {
  it('strips comments but keeps globs inside strings', () => {
    const src = '{\n  // a comment\n  "a": ["$TURBO_ROOT$/apps/*/src/**"], /* block */ "b": "x//y"\n}';
    expect(JSON.parse(stripJsonComments(src))).toEqual({
      a: ['$TURBO_ROOT$/apps/*/src/**'],
      b: 'x//y',
    });
  });

  it('test:coverage lists exactly the inputs test lists', () => {
    const tasks = readTasks();
    const test = tasks['test']?.inputs;
    const coverage = tasks['test:coverage']?.inputs;

    // Loud if either list vanishes: two missing lists would compare equal.
    expect(test, 'test.inputs').toBeDefined();
    expect(coverage, 'test:coverage.inputs').toBeDefined();
    expect(test!.length).toBeGreaterThan(1);

    const testSet = new Set(test);
    const coverageSet = new Set(coverage);
    expect({
      missingFromCoverage: [...testSet].filter((i) => !coverageSet.has(i)).sort(),
      extraInCoverage: [...coverageSet].filter((i) => !testSet.has(i)).sort(),
    }).toEqual({ missingFromCoverage: [], extraInCoverage: [] });
  });
});
