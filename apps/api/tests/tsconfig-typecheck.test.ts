import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { relative, resolve } from 'path';
import ts from 'typescript';

// Guard for the typecheck/build race fix (issue #52): `tsc` must not read
// anything under `.next/`, because a concurrent `next build` rewrites it. The
// guard lives in tsconfig.typecheck.json; this suite fails if that config, or
// the script that selects it, stops keeping `.next` out.

const backendRoot = resolve(__dirname, '..');
const sentinelDir = resolve(backendRoot, '.next/types/__typecheck_guard__');
const sentinel = resolve(sentinelDir, 'sentinel.ts');

function parse(configName: string) {
  const configPath = resolve(backendRoot, configName);
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, backendRoot, undefined, configPath);
  return {
    exclude: (parsed.raw.exclude ?? []) as string[],
    files: parsed.fileNames.map((f) => relative(backendRoot, f)),
  };
}

// A valid module, so it is harmless to a `next build` that happens to see it.
beforeAll(() => {
  mkdirSync(sentinelDir, { recursive: true });
  writeFileSync(sentinel, 'export {};\n');
});

afterAll(() => {
  rmSync(sentinelDir, { recursive: true, force: true });
});

describe('tsconfig.typecheck.json keeps tsc out of .next', () => {
  it('control: the base tsconfig.json DOES read .next/types and next-env.d.ts', () => {
    // Proves the probe can see the race surface at all — without this, the
    // assertions below would pass on a tree with no `.next` directory.
    const { files } = parse('tsconfig.json');
    expect(files).toContain(relative(backendRoot, sentinel));
    expect(files).toContain('next-env.d.ts');
  });

  it('includes no file under .next', () => {
    const { files } = parse('tsconfig.typecheck.json');
    expect(files.filter((f) => f.startsWith('.next'))).toEqual([]);
  });

  it('excludes next-env.d.ts, whose reference path re-imports .next/types', () => {
    expect(readFileSync(resolve(backendRoot, 'next-env.d.ts'), 'utf8')).toContain('.next/types/');
    expect(parse('tsconfig.typecheck.json').files).not.toContain('next-env.d.ts');
  });

  it('otherwise checks exactly the files the base config checks', () => {
    const inScope = (f: string) => !f.startsWith('.next') && f !== 'next-env.d.ts';
    const base = parse('tsconfig.json').files.filter(inScope).sort();
    expect(parse('tsconfig.typecheck.json').files.sort()).toEqual(base);
    expect(base.length).toBeGreaterThan(0);
  });

  it('repeats every base exclude (exclude replaces, it does not merge)', () => {
    const typecheck = parse('tsconfig.typecheck.json').exclude;
    for (const entry of parse('tsconfig.json').exclude) {
      expect(typecheck).toContain(entry);
    }
  });

  it('is the config the typecheck script actually uses', () => {
    const pkg = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.typecheck).toContain('-p tsconfig.typecheck.json');
  });
});
