/**
 * The repo files that wire this app into the monorepo stay in step with the code.
 *
 * Python counterpart: none. `turbo.json` runs in strict environment mode: a variable it does not list is invisible to the tasks
 * AND missing from the cache key, so a cached build could report a hit while ignoring a changed value (see the long comment in
 * `turbo.json`). apps/api and apps/auth rely on a person remembering to add each variable; this checks it for this app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../src/config';

const appRoot = join(import.meta.dirname, '..');
const repoRoot = join(appRoot, '..', '..');
const read = (path: string) => readFileSync(path, 'utf8');

/** The names inside the `"globalEnv": [ ... ]` list. `turbo.json` allows comments, so it cannot go through `JSON.parse`. */
function globalEnvNames(): string[] {
  // Comments go first: one in the list mentions `process.env[name]`, and its `]` would otherwise end the list early
  const text = read(join(repoRoot, 'turbo.json'))
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const open = text.indexOf('[', text.indexOf('"globalEnv"'));
  const close = text.indexOf(']', open);
  return [...text.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe('turbo.json', () => {
  it('lists every variable the configuration reads, so tasks see it and the cache key holds it', () => {
    const listed = new Set(globalEnvNames());
    expect(CONFIG_KEYS.filter((key) => !listed.has(key))).toEqual([]);
  });

  it('reads the right list: it holds a variable of another app too', () => {
    // Guards the parser above: if it returned an empty list, the check before it would pass for the wrong reason
    expect(globalEnvNames()).toContain('DATABASE_URL');
  });
});

describe('railway.toml and the Dockerfile', () => {
  const railway = read(join(appRoot, 'railway.toml'));
  const dockerfile = read(join(appRoot, 'Dockerfile'));

  it('point at each other', () => {
    expect(railway).toContain('dockerfilePath = "apps/whatsapp/Dockerfile"');
    expect(dockerfile).toContain('docker build -f apps/whatsapp/Dockerfile .');
  });

  it('rebuild on a change to anything the image contains', () => {
    for (const pattern of ['"apps/whatsapp/**"', '"packages/**"', '"pnpm-lock.yaml"', '".dockerignore"']) {
      expect(railway).toContain(pattern);
    }
  });

  it('check the health route the app serves', () => {
    expect(railway).toContain('healthcheckPath = "/"');
  });

  it('start the file the build writes, not a TypeScript source', () => {
    expect(dockerfile).toContain('CMD ["node", "dist/index.mjs"]');
    expect(read(join(appRoot, 'tsdown.config.ts'))).toContain("outDir: './dist'");
  });

  it('install and build only this app and what it depends on', () => {
    expect(dockerfile).toContain('pnpm install --frozen-lockfile --filter ansari-whatsapp...');
    expect(dockerfile).toContain('pnpm --filter ansari-whatsapp build');
  });

  it('run as the unprivileged node user', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
  });
});

describe('the root scripts', () => {
  const scripts = (JSON.parse(read(join(repoRoot, 'package.json'))) as { scripts: Record<string, string> }).scripts;

  it('keep the service out of `pnpm dev`, which would start it with no environment and crash it', () => {
    expect(scripts.dev).toContain('--filter=!ansari-whatsapp');
    expect(scripts['dev:no-auth']).toContain('--filter=!ansari-whatsapp');
  });

  it('offer `pnpm whatsapp dev` for running it on its own', () => {
    expect(scripts.whatsapp).toBe('pnpm --filter ansari-whatsapp');
  });
});

describe('the CI job', () => {
  const ci = read(join(repoRoot, '.github', 'workflows', 'ci.yml'));

  it('runs lint, typecheck, test and build for this app and loads its dummy env', () => {
    for (const step of ['lint', 'typecheck', 'test', 'build']) {
      expect(ci).toContain(`pnpm exec turbo run ${step} --filter ansari-whatsapp...`);
    }
    expect(ci).toContain("grep -v '^#' apps/whatsapp/.env.ci >> \"$GITHUB_ENV\"");
  });

  it('keeps the Python service\'s own job under its own name', () => {
    expect(ci).toContain('name: whatsapp (lint, format, test)');
    expect(ci).toContain('name: whatsapp service (lint, typecheck, test, build)');
  });
});
