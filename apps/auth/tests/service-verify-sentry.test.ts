// The MCP verify route under the service's own Sentry options (#314: no Sentry
// event or log line carries the key, any 16-character window of its random
// part, or the request body). Default integrations stay on, as in production;
// only the transport is a spy. Its own file: the Console integration patches
// `console` for the whole process.
import { inspect } from 'node:util';

import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getEnv, limits, serviceUsers } from '@ansari/auth';

import { MCP_VERIFY_ALERT_MESSAGE, SERVICE_SENTRY_OPTIONS } from '../src/alerts';
import { SERVICE_VERIFY_PATH } from '../src/routes/service-verify';
import { leakedWindows } from './helpers/leak-scan';
import { startService, type Service } from './helpers/service';

const MCP = { mcp: ['complete'] };
const envelopes: unknown[] = [];
const logged: unknown[][] = [];
const rawKeys: string[] = [];
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
  // After Sentry.init, so the Console integration's patch sits underneath.
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
  service = await startService();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await Sentry.close();
  await service?.close();
});

async function mcpKey(userId: string, metadata: unknown = { clientId: 'ansari-mcp-production' }) {
  const { key } = await service.auth.api.createApiKey({
    body: { userId, prefix: serviceUsers.keyPrefix('ansari-mcp', getEnv().ENVIRONMENT), permissions: MCP, metadata, rateLimitEnabled: false },
  });
  rawKeys.push(key);
  return key;
}

const post = (body: unknown) =>
  fetch(`${service.publicUrl}${SERVICE_VERIFY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Sentry events and logs from the verify route', () => {
  it('carry no key, no window of its random part and no body, across the alerting cases', async () => {
    const owner = await serviceUsers.createServiceUser(service.db, 'ansari-mcp');
    const good = await mcpKey(owner.id);
    const offPattern = await mcpKey(owner.id, { clientId: 'claude-skill' });
    const unknown = `${serviceUsers.keyPrefix('ansari-mcp', getEnv().ENVIRONMENT)}${'Z'.repeat(64)}`;
    rawKeys.push(unknown);

    expect((await post({ key: good, permissions: MCP })).status).toBe(200);
    // client-id-invalid, while the request (with its body) is in flight.
    expect(await (await post({ key: offPattern, permissions: MCP })).text()).toBe('{"valid":false}');
    // Refusal volume.
    for (let i = 0; i < limits.MCP_VERIFY_UNAUTHORIZED_ALERT.max; i++) {
      expect((await post({ key: unknown, permissions: MCP })).status).toBe(200);
    }
    // A 400 with a key in the body.
    expect((await post({ key: good, permissions: { whatsapp: ['mint'] } })).status).toBe(400);
    // service-user-unresolvable: the owner loses its `service` row; a 500.
    await service.client.query('delete from auth.account where user_id = $1', [owner.id]);
    expect((await post({ key: good, permissions: MCP })).status).toBe(500);
    await Sentry.flush(2000);

    const serialized = JSON.stringify(envelopes);
    for (const kind of ['client-id-invalid', 'unauthorized-volume', 'service-user-unresolvable']) {
      expect(serialized).toContain(`${MCP_VERIFY_ALERT_MESSAGE}: ${kind}`);
      expect(serialized).toContain(`mcp-verify-${kind}`);
    }
    expect(leakedWindows(serialized, rawKeys)).toEqual([]);
    expect(serialized).not.toContain('"permissions"');
    expect(serialized).not.toContain('claude-skill');

    const consoleText = logged.map((args) => args.map((a) => inspect(a, { depth: 8 })).join(' ')).join('\n');
    expect(consoleText).toContain(MCP_VERIFY_ALERT_MESSAGE);
    expect(leakedWindows(consoleText, rawKeys)).toEqual([]);
  });
});
