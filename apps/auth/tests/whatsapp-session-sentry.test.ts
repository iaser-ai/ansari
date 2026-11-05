// The exchange under the service's own Sentry options (spec 329: Sentry events
// from the exchange carry no request body, no Authorization header and no
// phone number). Default integrations stay on, as in production; only the
// transport is a spy. Its own file: the Console integration patches `console`
// for the whole process.
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serviceUsers } from '@ansari/auth';

import { EXCHANGE_ALERT_MESSAGE, SERVICE_SENTRY_OPTIONS } from '../src/alerts';
import { WHATSAPP_SESSION_PATH } from '../src/routes/whatsapp';
import { startService, type Service } from './helpers/service';

const envelopes: unknown[] = [];
let service: Service;

beforeAll(async () => {
  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    environment: 'test',
    ...SERVICE_SENTRY_OPTIONS,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
  service = await startService();
});

afterAll(async () => {
  await Sentry.close();
  await service?.close();
});

const post = (key: string, body: unknown) =>
  fetch(`${service.publicUrl}${WHATSAPP_SESSION_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Sentry events from the exchange', () => {
  // Runs first: the next case removes the whatsapp service user's `service` row.
  it("carry no ineligible user's id (the log line names it; no console breadcrumb rides on the alert)", async () => {
    const owner = await serviceUsers.createServiceUser(service.db, 'whatsapp');
    const { key } = await service.auth.api.createApiKey({
      body: { userId: owner.id, prefix: 'ansari_wa_', permissions: { whatsapp: ['mint'] }, rateLimitEnabled: false },
    });
    const bsuid = 'US.27182818284590452353';
    const first = await post(key, { bsuid });
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    const sub = (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;
    // Promoted to admin: the next exchange is ineligible (500), logs the id and raises the alert.
    await service.client.query(`update auth.users set role = 'admin' where id = $1`, [sub]);
    envelopes.length = 0;
    expect((await post(key, { bsuid })).status).toBe(500);
    await Sentry.flush(2000);

    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain('ineligible-user');
    for (const needle of [sub, bsuid, key, key.slice(3, 20), token]) {
      expect(serialized).not.toContain(needle);
    }
    // Leave the service user as the next case expects to create it: gone.
    await service.client.query('delete from auth.users where id = $1 or id = $2', [owner.id, sub]);
  });

  it('carry no body, Authorization header, BSUID, phone number or key', async () => {
    // A key whose owner has lost its `service` row: the route raises the
    // service-user alert while the request (with its body) is in flight.
    const owner = await serviceUsers.createServiceUser(service.db, 'whatsapp');
    const { key } = await service.auth.api.createApiKey({
      body: { userId: owner.id, prefix: 'ansari_wa_', permissions: { whatsapp: ['mint'] }, rateLimitEnabled: false },
    });
    await service.client.query('delete from auth.account where user_id = $1', [owner.id]);

    const bsuid = 'US.48151623420815162342';
    const phone = '15550001111';
    const res = await fetch(`${service.publicUrl}${WHATSAPP_SESSION_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bsuid, phone_number: phone }),
    });
    expect(res.status).toBe(500);
    await Sentry.flush(2000);

    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain(EXCHANGE_ALERT_MESSAGE);
    for (const needle of [bsuid, phone, key, key.slice(3, 20), 'phone_number', 'bsuid']) {
      expect(serialized).not.toContain(needle);
    }
    expect(serialized.toLowerCase()).not.toContain('authorization');
  });
});
