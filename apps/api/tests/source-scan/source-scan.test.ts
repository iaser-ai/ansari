// Source scans (spec 300, plan phase 9). Each scan is proven on a planted
// known-bad line and a near-miss before it is trusted on the tree, and each
// tree scan asserts a file floor, so an empty walk cannot pass. The hit counts
// are printed and recorded in the review.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  authDependencyHits,
  authImportHits,
  databaseUrlHits,
  isExcludedFromDatabaseUrlScan,
  legacySqlHits,
  readSource,
  removedHopHits,
  removedHopTextHits,
  sourceFiles,
} from './scan';

function report(name: string, files: string[], hits: Record<string, string[]>): void {
  const count = Object.values(hits).reduce((n, h) => n + h.length, 0);
  console.info(`[source-scan] ${name}: ${count} hits in ${files.length} files`);
}

function scanTree(files: string[], scan: (source: string) => string[]): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  for (const file of files) {
    const found = scan(readSource(file));
    if (found.length > 0) hits[file] = found;
  }
  return hits;
}

// apps/api's runtime code: what `next build` compiles and its config files.
const API_RUNTIME = [
  ...sourceFiles('apps/api/src'),
  ...sourceFiles('apps/api/lib'),
  ...sourceFiles('apps/api/db'),
  'apps/api/next.config.ts',
  'apps/api/drizzle.config.ts',
  'apps/api/sentry.server.config.ts',
  'apps/api/sentry.client.config.ts',
];

// apps/auth's runtime code: the service, its operator scripts, and the auth
// library it runs (packages/auth).
const AUTH_RUNTIME = [
  ...sourceFiles('apps/auth/src'),
  ...sourceFiles('apps/auth/scripts'),
  ...sourceFiles('packages/auth/src'),
];

describe('scan 1: apps/api runtime names no legacy auth column or table in raw SQL', () => {
  it('catches planted lines', () => {
    for (const bad of [
      'db.execute(sql`SELECT password_hash FROM users WHERE id = ${id}`);',
      "await client.query('UPDATE users SET session_version = session_version + 1');",
      'sql`SELECT id FROM users WHERE is_admin = true`;',
      'sql`DELETE FROM tokens WHERE user_id = ${id}`;',
      'sql`INSERT INTO public.tokens (user_id) VALUES (${id})`;',
      'sql`SELECT * FROM ${users} WHERE id = ${id}`;',
      "pool.query('select * from \"users\" limit 1');",
      'sql`SELECT u.* FROM users u`;',
    ]) {
      expect(legacySqlHits(bad), bad).not.toEqual([]);
    }
  });

  it('ignores near-misses', () => {
    for (const fine of [
      '// password_hash stays NULL; session_version and is_admin are gone',
      '/* DELETE FROM tokens */ const x = 1;',
      'const passwordHashLength = 60;',
      "const body = { max_tokens: 8192, label: 'tokens used' };",
      'sql`SELECT * FROM ${threads} WHERE user_id = ${id}`;',
      'sql`SELECT * FROM users_archive`;',
      'sql`INSERT INTO ${users} (id, email) VALUES (${id}, ${email})`;',
      'sql`SELECT id, email FROM users WHERE id = ${id}`;',
    ]) {
      expect(legacySqlHits(fine), fine).toEqual([]);
    }
  });

  it('the apps/api runtime tree has no hits', () => {
    expect(API_RUNTIME.length).toBeGreaterThan(60);
    const hits = scanTree(API_RUNTIME, legacySqlHits);
    report('legacy SQL (apps/api runtime)', API_RUNTIME, hits);
    expect(hits).toEqual({});
  });
});

describe('scan 2: no runtime code names a split database URL or holds a literal one', () => {
  it('catches planted lines', () => {
    for (const bad of [
      'const url = process.env.APP_DATABASE_URL;',
      "const url = process.env['AUTH_DATABASE_URL'];",
      "const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/ansari';",
      'const url = `postgresql://${user}:${pass}@${host}/auth`;',
    ]) {
      expect(databaseUrlHits(bad), bad).not.toEqual([]);
    }
  });

  it('ignores near-misses', () => {
    for (const fine of [
      'const url = process.env.DATABASE_URL;',
      "const url = getEnv().DATABASE_URL; // not AUTH_DATABASE_URL: one URL per service",
      '/* postgres://user@host/db is the shape */ const x = 1;',
      "const name = 'MY_APP_DATABASE_URL_BACKUP';",
      "const docs = 'https://postgres.example.org/docs';",
    ]) {
      expect(databaseUrlHits(fine), fine).toEqual([]);
    }
  });

  it('excludes the cutover scripts directory, and only it', () => {
    expect(isExcludedFromDatabaseUrlScan('apps/auth/scripts/cutover/copy-users.ts')).toBe(true);
    expect(isExcludedFromDatabaseUrlScan('apps/auth/scripts/cutover/audit/verify.ts')).toBe(true);
    for (const scanned of [
      'apps/auth/scripts/grant-admin.ts',
      'apps/auth/scripts/cutover-tools/copy.ts',
      'apps/auth/scripts/cutover.ts',
      'apps/auth/src/scripts/cutover/copy.ts',
      'apps/api/scripts/cutover/copy.ts',
      'packages/auth/src/cutover/copy.ts',
    ]) {
      expect(isExcludedFromDatabaseUrlScan(scanned), scanned).toBe(false);
    }
  });

  it('apps/api and apps/auth runtime trees have no hits', () => {
    const files = [...API_RUNTIME, ...AUTH_RUNTIME].filter((f) => !isExcludedFromDatabaseUrlScan(f));
    expect(AUTH_RUNTIME.length).toBeGreaterThan(20);
    const hits = scanTree(files, databaseUrlHits);
    report('split/literal database URL (apps/api + apps/auth runtime)', files, hits);
    expect(hits).toEqual({});
  });
});

describe('scan 3: apps/api has no better-auth or @ansari/auth import or dependency', () => {
  it('catches planted lines', () => {
    for (const bad of [
      "import { betterAuth } from 'better-auth';",
      "import { users } from '@ansari/auth';",
      "export { createAuth } from '@ansari/auth/server';",
      "const x = await import('better-auth/plugins');",
      "const { createAuth } = require('@ansari/auth');",
      "import { expo } from '@better-auth/expo';",
      "import 'better-auth';",
    ]) {
      expect(authImportHits(bad), bad).not.toEqual([]);
    }
    expect(authDependencyHits({ dependencies: { 'better-auth': '1.7.7' } })).toEqual(['better-auth']);
    expect(authDependencyHits({ devDependencies: { '@ansari/auth': 'workspace:*' } })).toEqual(['@ansari/auth']);
    expect(authDependencyHits({ dependencies: { '@better-auth/expo': '1.7.7' } })).toEqual(['@better-auth/expo']);
  });

  it('ignores near-misses', () => {
    for (const fine of [
      "import { CLIENT_HEADER } from '@ansari/types/attribution';",
      "// apps/auth runs better-auth; import { x } from 'better-auth' is never written here",
      "import { x } from './better-auth-notes';",
      "import { y } from '@ansari/authz';",
      "const label = 'better-auth';",
    ]) {
      expect(authImportHits(fine), fine).toEqual([]);
    }
    expect(authDependencyHits({ dependencies: { '@ansari/types': 'workspace:*', jose: '^6' } })).toEqual([]);
  });

  it('apps/api runtime has no import, and its package.json no dependency', () => {
    const hits = scanTree(API_RUNTIME, authImportHits);
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps/api/package.json'), 'utf8'));
    const deps = authDependencyHits(pkg);
    report('better-auth/@ansari/auth imports (apps/api runtime)', API_RUNTIME, hits);
    console.info(`[source-scan] better-auth/@ansari/auth dependencies (apps/api/package.json): ${deps.length} hits`);
    expect(hits).toEqual({});
    expect(deps).toEqual([]);
  });
});

describe('scan 4: the removed internal hop stays gone (owner amendment 2026-10-17)', () => {
  // apps/api reaches apps/auth at its public URL with no shared secret, no
  // forwarded IP and no internal listener. These are the hop's names.
  const CONFIG = [
    'turbo.json',
    '.github/workflows/ci.yml',
    'apps/auth/Dockerfile',
    'apps/auth/railway.toml',
    'apps/api/railway.toml',
    'apps/api/eslint.config.mjs',
    'apps/auth/.env.example',
    'apps/auth/.env.ci',
    'apps/api/.env.example',
    'apps/api/.env.ci',
  ];

  it('catches planted lines', () => {
    for (const bad of [
      'const secret = process.env.AUTH_INTERNAL_SECRET;',
      "const url = getEnv()['AUTH_INTERNAL_URL'];",
      'app.listen(env.INTERNAL_PORT);',
      "const mode = process.env.AUTH_RATE_LIMIT_MODE ?? 'email';",
      'await assertConfiguredAdminsExist(db, env.ADMIN_EMAILS);',
      "const admins = (process.env.ADMIN_EMAILS ?? '').split(',');",
      "headers['x-ansari-internal-auth'] = secret;",
      "headers['X-Ansari-Forwarded-Client-IP'] = ip;",
      'headers[INTERNAL_AUTH_HEADER] = secret;',
      'headers[FORWARDED_IP_HEADER] = ip;',
      "fetch('http://auth.railway.internal:3101/api/auth/jwks');",
      "router.use('/internal', internalRouter);",
      'await fetch(`/internal/users/${id}/profile`);',
    ]) {
      expect(removedHopHits(bad), bad).not.toEqual([]);
    }
  });

  it('ignores near-misses', () => {
    for (const fine of [
      '// AUTH_INTERNAL_SECRET and the /internal/ routes were removed (2026-10-17)',
      'const { internalAdapter } = await auth.$context;',
      "headers['x-ansari-client'] = 'ios';",
      'const internal = false;',
      "fetch('/api/account/me');",
      "const path = '/internals-guide';",
      'const url = process.env.AUTH_URL;',
      "const host = 'postgres.railway.internal'; // a cutover database host (H-8)",
      'const admins = await users.listAdmins(db);',
      "const role = users.ADMIN_ROLE; // 'admin'",
    ]) {
      expect(removedHopHits(fine), fine).toEqual([]);
    }
  });

  it('the config-file scan reads comments too', () => {
    expect(removedHopTextHits('# INTERNAL_PORT  3101  internal listener')).not.toEqual([]);
    expect(removedHopTextHits('# One listener, PORT (3100)')).toEqual([]);
  });

  it('apps/api and apps/auth runtime trees and the config files have no hits', () => {
    const files = [...API_RUNTIME, ...AUTH_RUNTIME];
    expect(files.length).toBeGreaterThan(80);
    const hits = scanTree(files, removedHopHits);
    for (const file of CONFIG) {
      const found = removedHopTextHits(readSource(file));
      if (found.length > 0) hits[file] = found;
    }
    report('removed internal hop (runtime + config)', [...files, ...CONFIG], hits);
    expect(hits).toEqual({});
  });
});
