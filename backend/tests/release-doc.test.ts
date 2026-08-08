import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// RELEASE.md is an operational runbook: every command, endpoint, and file it
// names must exist in this repo, or an operator following it mid-release gets
// stranded. These tests pin the doc to reality so drift fails CI.

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(backendDir, '..');
const releasePath = resolve(repoRoot, 'RELEASE.md');

const doc = readFileSync(releasePath, 'utf8');
const pkg = JSON.parse(readFileSync(resolve(backendDir, 'package.json'), 'utf8'));

describe('RELEASE.md consistency', () => {
  it('exists at the repo root', () => {
    expect(existsSync(releasePath)).toBe(true);
  });

  it('only references package scripts that exist in backend/package.json', () => {
    // Matches both `pnpm <script>` and `pnpm run <script>`; the alternation
    // excludes pnpm's own subcommands (install/exec/etc.) and the workspace
    // convenience scripts (`pnpm build:web` lives in the frontend, matched out
    // by requiring the script to exist here only for backend-context refs).
    const scripts = [...doc.matchAll(/pnpm (?:run )?((?:db:)?(?:generate|migrate|push|build|start|dev|test|lint|typecheck)(?::[a-z-]+)?)\b/g)].map(
      (m) => m[1],
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(pkg.scripts, `pnpm ${script} referenced but not defined`).toHaveProperty(script);
    }
    // The npm era is over: any npm invocation in the runbook is drift.
    // (lookbehind so `pnpm install` doesn't match its own `npm install` tail)
    expect(doc).not.toMatch(/(?<!p)npm (run|ci|install|test)\b/);
  });

  it('mentions db:push only to prohibit it', () => {
    const lines = doc.split('\n').filter((l) => l.includes('db:push'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `db:push line lacks a prohibition: "${line}"`).toMatch(/never|not/i);
    }
  });

  it('only references API endpoints that exist as route files', () => {
    // '.' is deliberately absent from the class so domain names in URLs
    // (https://api.askansari.ai/...) never match as endpoint paths.
    const paths = [...new Set([...doc.matchAll(/\/api\/[A-Za-z0-9_$/[\]-]+/g)].map((m) => m[0]))];
    expect(paths.length).toBeGreaterThan(3);
    for (const apiPath of paths) {
      const routePath = apiPath.replace('$THREAD', '[id]');
      const routeFile = resolve(backendDir, 'src/app', `.${routePath}`, 'route.ts');
      expect(existsSync(routeFile), `${apiPath} has no route at ${routeFile}`).toBe(true);
    }
  });

  it('only references repo files that exist', () => {
    const referenced = [
      '.github/workflows/ci.yml',
      'backend/railway.toml',
      'backend/drizzle/0000_baseline.sql',
      'backend/sentry.server.config.ts',
      'docs/self-hosting.md',
    ];
    for (const rel of referenced) {
      expect(doc, `expected RELEASE.md to reference ${rel}`).toContain(rel);
      expect(existsSync(resolve(repoRoot, rel)), `${rel} referenced but missing`).toBe(true);
    }
    // Referenced relative to backend/ in the doc:
    expect(doc).toContain('scripts/grant-admin.ts');
    expect(existsSync(resolve(backendDir, 'scripts/grant-admin.ts'))).toBe(true);
  });

  it('pins exactly the two production health-check domains', () => {
    expect(doc).toContain('https://api.askansari.ai/api/health');
    expect(doc).toContain('https://api-35.ansari.chat/api/health');
    // Historical wrong guess — must never reappear.
    expect(doc).not.toContain('api.ansari.chat');
  });
});
