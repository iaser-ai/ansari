import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * docs/self-hosting.md against the code (issue #21; spec 300 amendment H-7).
 * apps/auth runs no admin check at boot any more, so the docs must not send an
 * operator to triage one, and must describe the two-step grant.
 */

const doc = readFileSync(resolve(__dirname, '../../../docs/self-hosting.md'), 'utf8');
const entry = readFileSync(resolve(__dirname, '../../auth/src/index.ts'), 'utf8');

describe('self-hosting docs: admins (H-7)', () => {
  it('apps/auth has no boot admin check, and the docs say so', () => {
    expect(existsSync(resolve(__dirname, '../../auth/src/startup-checks.ts'))).toBe(false);
    expect(entry).not.toMatch(/assertConfiguredAdminsExist|startup-checks/);
    expect(doc).toMatch(/`apps\/auth` runs no admin check at boot/);
    expect(doc).not.toMatch(/Admin bootstrap check could not reach the database|has no account|role is not admin/);
  });

  it('points operators at the two-step grant script', () => {
    expect(doc).toContain('scripts/grant-admin.ts');
    expect(doc).toContain('from\n`apps/auth/`');
    expect(doc).toContain('`grant-admin.ts <email> --confirm <id>`');
    expect(existsSync(resolve(__dirname, '../../auth/scripts/grant-admin.ts'))).toBe(true);
  });

  it("keeps backend's legacy ADMIN_EMAILS until the contract PR, for the rollback", () => {
    expect(doc).toMatch(/legacy\*\* `ADMIN_EMAILS`[\s\S]*stays set on the\s+`backend` service until the contract PR/);
  });
});

describe('self-hosting docs: two databases, two services (spec 300)', () => {
  it('asks for two databases and runs both services', () => {
    expect(doc).toMatch(/two databases/i);
    expect(doc).toContain('applies packages/auth/drizzle/ to DATABASE_URL (the auth database)');
    expect(existsSync(resolve(__dirname, '../../../packages/auth/drizzle/0000_auth_schema.sql'))).toBe(true);
    expect(doc).toContain('pnpm auth dev');
    expect(doc).toContain('pnpm api dev');
  });

  it('applies production migrations by psql with both flags, never by db:migrate or db:push', () => {
    expect(doc).toContain('psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>');
    expect(doc).toMatch(/Production migrations are \*\*not\*\* applied with `pnpm db:migrate`/);
    expect(doc).not.toMatch(/applied with `pnpm db:migrate` \(from `apps\/api\/`\) against\s+the production/);
  });
});
