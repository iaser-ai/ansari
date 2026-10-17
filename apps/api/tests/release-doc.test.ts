import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// RELEASE.md is an operational runbook: every command, endpoint, and file it
// names must exist in this repo, or an operator following it mid-release gets
// stranded. These tests pin the doc to reality so drift fails CI.

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// apps/api/tests -> apps/api -> apps -> <repo root>. Three levels: this file
// lives two below the app root, and the app now sits under apps/.
const repoRoot = resolve(apiDir, '../..');
const releasePath = resolve(repoRoot, 'RELEASE.md');

const doc = readFileSync(releasePath, 'utf8');
const pkg = JSON.parse(readFileSync(resolve(apiDir, 'package.json'), 'utf8'));

describe('RELEASE.md consistency', () => {
  it('exists at the repo root', () => {
    expect(existsSync(releasePath)).toBe(true);
  });

  it('only references package scripts that exist in apps/api/package.json', () => {
    // Matches both `pnpm <script>` and `pnpm run <script>`; the alternation
    // excludes pnpm's own subcommands (install/exec/etc.) and the workspace
    // convenience scripts (`pnpm build:web` lives in the frontend, matched out
    // by requiring the script to exist here only for api-context refs).
    //
    // ASSUMPTION (explicit, not incidental): RELEASE.md is an operational
    // runbook executed FROM apps/api, so every `pnpm <script>` it names is
    // resolved against apps/api/package.json. If the runbook is ever rewritten
    // to quote root-level (turbo) scripts, this assertion becomes wrong even
    // where it still passes by coincidence of overlapping script names.
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
    //
    // The `(?<!apps)` lookbehind excludes REPO PATHS from endpoint extraction.
    // Since the backend app lives at `apps/api/`, any doc reference to a file
    // inside it (e.g. `apps/api/railway.toml`) contains the substring `/api/`
    // and would otherwise be extracted as an endpoint named `/api/railway` —
    // then fail because no such route file exists. Endpoints in this doc are
    // always root-relative or on a host (`localhost:3000/api/...`), never
    // preceded by `apps`, so the lookbehind separates the two cleanly.
    const paths = [
      ...new Set([...doc.matchAll(/(?<!apps)\/api\/[A-Za-z0-9_$/[\]-]+/g)].map((m) => m[0])),
    ].filter((p) => !p.startsWith('/api/auth/'));
    expect(paths.length).toBeGreaterThan(3);
    for (const apiPath of paths) {
      const routePath = apiPath.replace('$THREAD', '[id]');
      const routeFile = resolve(apiDir, 'src/app', `.${routePath}`, 'route.ts');
      expect(existsSync(routeFile), `${apiPath} has no route at ${routeFile}`).toBe(true);
    }
  });

  it("references only apps/auth's own endpoints under /api/auth/ (served by apps/auth, not apps/api)", () => {
    // Better Auth's router serves these on apps/auth; the contract suite
    // (apps/auth/tests/frontend-client.test.ts) pins each one's behaviour.
    const known = new Set(['/api/auth/sign-in/email', '/api/auth/sign-up/email', '/api/auth/token', '/api/auth/jwks']);
    const authPaths = [...new Set([...doc.matchAll(/\/api\/auth\/[A-Za-z0-9_/-]+/g)].map((m) => m[0]))];
    expect(authPaths.length).toBeGreaterThan(0);
    for (const authPath of authPaths) {
      expect(known.has(authPath), `${authPath} is not a pinned apps/auth endpoint`).toBe(true);
    }
  });

  it('applies every migration with ON_ERROR_STOP and --single-transaction, naming the database', () => {
    const applies = doc.split('\n').filter((l) => /psql .*-f \S*drizzle\/\S+\.sql/.test(l) || /psql .*--single-transaction \\$/.test(l));
    // The two production applies (app + auth); the fresh-database smoke uses db:migrate.
    expect(applies.length).toBeGreaterThanOrEqual(2);
    for (const line of applies) {
      expect(line, `apply without both flags: "${line.trim()}"`).toMatch(/-v ON_ERROR_STOP=1 --single-transaction/);
    }
    expect(doc).toContain('psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/');
    expect(doc).toContain('psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/');
    // The old unflagged form must not come back.
    expect(doc).not.toMatch(/psql "\$DATABASE_URL" -f/);
  });

  it('points at the cutover runbook and its rollback, which exist', () => {
    for (const rel of ['docs/cutover/better-auth-cutover.md', 'docs/cutover/rollback.md']) {
      expect(doc).toContain(rel);
      expect(existsSync(resolve(repoRoot, rel)), `${rel} missing`).toBe(true);
    }
    expect(doc).toMatch(/schema freeze/i);
  });

  it('only references repo files that exist', () => {
    const referenced = [
      '.github/workflows/ci.yml',
      'apps/api/railway.toml',
      'apps/api/drizzle/0000_baseline.sql',
      'apps/api/sentry.server.config.ts',
      'docs/self-hosting.md',
    ];
    for (const rel of referenced) {
      expect(doc, `expected RELEASE.md to reference ${rel}`).toContain(rel);
      expect(existsSync(resolve(repoRoot, rel)), `${rel} referenced but missing`).toBe(true);
    }
    // Referenced relative to apps/auth/ in the doc (spec 300 moved it there):
    expect(doc).toContain('from `apps/auth/`');
    expect(doc).toContain('scripts/grant-admin.ts');
    expect(existsSync(resolve(repoRoot, 'apps/auth/scripts/grant-admin.ts'))).toBe(true);
    expect(existsSync(resolve(apiDir, 'scripts/grant-admin.ts'))).toBe(false);
  });

  it('pins exactly the two production health-check domains', () => {
    expect(doc).toContain('https://api.askansari.ai/api/health');
    expect(doc).toContain('https://api-35.ansari.chat/api/health');
    // Historical wrong guess — must never reappear.
    expect(doc).not.toContain('api.ansari.chat');
  });
});
