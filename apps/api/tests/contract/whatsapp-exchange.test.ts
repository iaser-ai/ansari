import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

/**
 * A token from apps/auth's WhatsApp exchange (spec 329) works in apps/api
 * unchanged: the real apps/auth over its own pglite mints it for a BSUID, and
 * a real apps/api route accepts it through `requireUser` (JWKS verification,
 * first-use `GET /api/account/me` with that token, a `public.users` row under
 * the same UUID). apps/api has no WhatsApp code (source-scan scan 5); this is
 * the proof it needs none. Only the app `db` handle and Sentry are mocked.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: () => {}, setUser: () => {} }));

import { GET as threadsGet } from '../../src/app/api/v2/threads/route';
import { serviceUsers } from '../../../../packages/auth/src';
import { appDrizzle, migrateAppDb, startAuth, type AuthService } from '../auth/helpers';

const EXCHANGE_PATH = '/api/whatsapp/session';

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');

let service: AuthService;
let app: PGlite;
let key: string;

beforeAll(async () => {
  service = await startAuth();
  app = await migrateAppDb();
  h.db = appDrizzle(app);
  const serviceUser = await serviceUsers.createServiceUser(service.db, 'whatsapp');
  // A `whatsapp: mint` key for the WhatsApp service user, with the script's prefix and
  // permission but no rate limit (so `requestCount` never moves) and no budget: this test
  // proves the token path, not the key's limits.
  ({ key } = await service.auth.api.createApiKey({
    body: {
      userId: serviceUser.id,
      prefix: 'ansari_wa_',
      name: 'contract',
      permissions: { whatsapp: ['mint'] },
      rateLimitEnabled: false,
    },
  }));
});

afterAll(async () => {
  await service.close();
  await app.close();
});

/** The exchange, called as the WhatsApp service calls it: bearer key, JSON body. */
async function exchange(body: Record<string, string>): Promise<string> {
  const res = await fetch(`${service.publicUrl}${EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function getThreads(token: string) {
  const res = await threadsGet(
    new NextRequest('http://localhost/api/v2/threads', { headers: { authorization: `Bearer ${token}` } })
  );
  return { status: res.status, text: await res.text() };
}

/** Every row of every table in the app database, as text. */
async function appDatabaseText(): Promise<string> {
  const { rows } = await app.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'public'"
  );
  const dumps = await Promise.all(
    rows.map(async ({ name }) => {
      const result = await app.query<{ row: string }>(`select row_to_json(t)::text as row from "${name}" t`);
      return result.rows.map((r) => r.row).join('\n');
    })
  );
  return dumps.join('\n');
}

/** Every row of every table in the auth database, as text (spec 329 §5: no phone number stored). */
async function authDatabaseText(): Promise<string> {
  const { rows } = await service.client.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'auth'"
  );
  const dumps = await Promise.all(
    rows.map(async ({ name }) => {
      const result = await service.client.query<{ row: string }>(`select row_to_json(t)::text as row from auth."${name}" t`);
      return result.rows.map((r) => r.row).join('\n');
    })
  );
  return dumps.join('\n');
}

describe('a WhatsApp exchange token through apps/api requireUser', () => {
  it('passes, creates the app row on first use under the same UUID, and carries no phone number', async () => {
    const bsuid = `US.${digits(20)}`;
    const phone = `1${digits(11)}`;
    const token = await exchange({ bsuid, phone_number: phone });
    const [, payload] = token.split('.');
    const { sub } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string };

    const first = await getThreads(token);
    expect(first.status).toBe(200);

    const { rows } = await app.query<Record<string, unknown>>(
      'select id, email, registered_via from users where id = $1',
      [sub]
    );
    expect(rows).toEqual([{ id: sub, email: `whatsapp-${sub}@noreply.askansari.ai`, registered_via: 'whatsapp' }]);

    // A second message: a fresh exchange for the same BSUID, the same user and row.
    const again = await getThreads(await exchange({ bsuid }));
    expect(again.status).toBe(200);
    const { rows: count } = await app.query<{ n: number }>('select count(*)::int as n from users');
    expect(count[0].n).toBe(1);

    const appText = await appDatabaseText();
    expect(appText).toContain(sub);
    // The phone number is accepted and ignored at apps/auth too: in no auth row (spec 329 §5).
    const authText = await authDatabaseText();
    expect(authText).toContain(bsuid);
    expect(authText).not.toContain(phone);
    for (const sensitive of [phone, bsuid]) {
      expect(appText).not.toContain(sensitive);
      expect(first.text).not.toContain(sensitive);
      expect(again.text).not.toContain(sensitive);
    }
  });
});
