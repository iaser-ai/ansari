// The service-keys script with no SENTRY_DSN (security PR gate, pass 1, R3).
// Its own file: Sentry is the real module and never initialised here, so the
// test shows the unrecorded path is taken on purpose, not because an
// uninitialised Sentry's flush happens to answer false.
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_UNRECORDED, scriptRecorder, scriptSentryInit, serviceKeys, unrecordedRecorder, validEnvironment } from '../scripts/service-keys';
import { startService, type Service } from './helpers/service';

let service: Service;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  await service.close();
});

async function run(argv: string[], recorder: ReturnType<typeof scriptRecorder>) {
  const lines: string[] = [];
  const result = await serviceKeys(argv, {
    databaseUrl: 'postgres://db.example:6543/auth',
    environment: 'staging',
    connect: () => ({ db: service.db, auth: service.auth }),
    recorder,
    print: (line) => lines.push(line),
  });
  return { ...result, text: lines.join('\n') };
}

it('no DSN: nothing is captured or flushed; the write stands, the banner names the key id, exit 3', async () => {
  expect(Sentry.getClient()).toBeUndefined();
  const recorder = scriptRecorder(undefined, 'staging');
  expect(recorder).toBe(unrecordedRecorder);
  expect(Sentry.getClient()).toBeUndefined();

  const created = await run(['create-service', 'whatsapp', '--confirm', 'whatsapp'], recorder);
  expect(created.exitCode, created.text).toBe(EXIT_UNRECORDED);
  const { rows } = await service.client.query<{ id: string }>(
    `select user_id as id from auth.account where provider_id = 'service' and account_id = 'whatsapp'`
  );
  const userId = rows[0]!.id;

  const keyed = await run(
    ['create-key', 'whatsapp', '--rate-max', '60', '--rate-window', '60', '--daily', '3000', '--confirm', userId],
    recorder
  );
  expect(keyed.exitCode, keyed.text).toBe(EXIT_UNRECORDED);
  const keyId = /Created \w+ key ([0-9a-f-]{36})/.exec(keyed.text)![1]!;
  const banner = keyed.text.slice(keyed.text.indexOf('THE SENTRY RECORD'));
  expect(banner).toContain('SENTRY_DSN is not set: no record was attempted.');
  expect(banner).toContain(`key ${keyId}`);
  const { rows: keys } = await service.client.query('select id from auth.apikey where id = $1', [keyId]);
  expect(keys).toHaveLength(1);

  // Still never initialised: with no client a capture is unobservable, so the
  // path is shown by the recorder chosen and the reason in the banner, which
  // the old implicit path (an uninitialised flush answering false) never printed.
  expect(Sentry.getClient()).toBeUndefined();
});

describe('the script\'s Sentry environment (#314 Amendment 3, codex)', () => {
  it('is ENVIRONMENT, never NODE_ENV', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(scriptSentryInit('https://public@o0.ingest.sentry.io/0', 'staging').environment).toBe('staging');
      expect(scriptSentryInit('https://public@o0.ingest.sentry.io/0', 'production').environment).toBe('production');
      // main() validates before scriptRecorder: a typo never reaches Sentry.init.
      for (const bad of [undefined, '', 'prod', 'Production', 'test']) expect(validEnvironment(bad), String(bad)).toBeNull();
      for (const good of ['development', 'staging', 'production']) expect(validEnvironment(good)).toBe(good);
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

