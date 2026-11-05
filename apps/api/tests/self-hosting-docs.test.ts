import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { limits } from '../../../packages/auth/src';

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

describe('self-hosting docs: service keys and the WhatsApp exchange (spec 329)', () => {
  const section = doc.slice(doc.indexOf('### Service keys and the WhatsApp exchange'));

  it('names the route, the script and the runbook, and each exists', () => {
    expect(section).toContain('`POST /api/whatsapp/session`');
    expect(readFileSync(resolve(__dirname, '../../auth/src/alerts.ts'), 'utf8')).toContain(
      "WHATSAPP_SESSION_PATH = '/api/whatsapp/session'"
    );
    expect(section).toContain('`apps/auth/scripts/service-keys.ts`');
    expect(existsSync(resolve(__dirname, '../../auth/scripts/service-keys.ts'))).toBe(true);
    expect(section).toContain('`docs/cutover/service-keys-runbook.md`');
    expect(existsSync(resolve(__dirname, '../../../docs/cutover/service-keys-runbook.md'))).toBe(true);
  });

  it("states limits.ts's values as they are", () => {
    const initial = limits.WHATSAPP_KEY_INITIAL;
    expect(initial.rateLimitTimeWindow).toBe(60_000);
    expect(section).toContain(`(\`WHATSAPP_KEY_INITIAL\`: ${initial.rateLimitMax} per minute, 3,000 a day)`);
    expect(initial.refillAmount).toBe(3000);
    const perUser = limits.WHATSAPP_EXCHANGE_PER_USER;
    expect(section).toContain(`(\`WHATSAPP_EXCHANGE_PER_USER\`: ${perUser.max} per\n${perUser.window / 60} minutes)`);
    const { rateLimitMax, rateLimitTimeWindow, refillAmount } = limits.WHATSAPP_KEY_BOUNDS;
    expect([rateLimitTimeWindow.min, rateLimitTimeWindow.max]).toEqual([1000, 24 * 60 * 60 * 1000]);
    const n = (v: number) => v.toLocaleString('en-US');
    expect(section).toContain(
      `(\`WHATSAPP_KEY_BOUNDS\`, inclusive: \`--rate-max\` ${n(rateLimitMax.min)} to ${n(rateLimitMax.max)}, \`--rate-window\` 1 second to\n24 hours, \`--daily\` ${n(refillAmount.min)} to ${n(refillAmount.max)})`
    );
  });

  it('puts migration 0001 before the code, which refuses to boot without it', () => {
    expect(section).toMatch(/\*\*Migration before code\.\*\* `packages\/auth\/drizzle\/0001_api_key\.sql`/);
    expect(existsSync(resolve(__dirname, '../../../packages/auth/drizzle/0001_api_key.sql'))).toBe(true);
    expect(section).toMatch(/refuses to boot\s+without it/);
    expect(doc).toMatch(/refuses to start when the auth database lacks `auth\.apikey`/);
  });
});
