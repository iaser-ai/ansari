// The service-keys script under Sentry's PRODUCTION defaults (spec 329: no
// Sentry event carries key material). Default integrations stay on, so the
// Console integration turns console lines into breadcrumbs, exactly as in the
// script's own Sentry.init; only the transport is a spy. Its own file: the
// Console integration patches `console` for the whole process.
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { serviceUsers } from '@ansari/auth';

import {
  KEY_EVENT_MESSAGE,
  printLine,
  SCRIPT_SENTRY_OPTIONS,
  sentryRecorder,
  serviceKeys,
} from '../scripts/service-keys';
import { startService, type Service } from './helpers/service';

const DB_URL = 'postgres://ops:pw@db.example:6543/auth';
const LIMIT_FLAGS = ['--rate-max', '60', '--rate-window', '60', '--daily', '3000'];

const envelopes: unknown[] = [];
let service: Service;
let userId: string;

beforeAll(async () => {
  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    ...SCRIPT_SENTRY_OPTIONS,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
  service = await startService();
  await serviceUsers.createServiceUser(service.db, 'whatsapp');
  const found = await serviceUsers.findServiceUser(service.db, 'whatsapp');
  if (found.kind !== 'one') throw new Error('no service user');
  userId = found.user.id;
});
afterAll(async () => {
  await Sentry.close();
  await service.close();
});
beforeEach(() => {
  envelopes.length = 0;
});

async function createKey(print: (line: string) => void) {
  const result = await serviceKeys(['create-key', 'whatsapp', ...LIMIT_FLAGS, '--confirm', userId], {
    databaseUrl: DB_URL,
    connect: () => ({ db: service.db, auth: service.auth }),
    recorder: sentryRecorder,
    print,
  });
  expect(result.exitCode).toBe(0);
  const key = result.lines.find((l) => /^ansari_wa_[A-Za-z]{64}$/.test(l));
  if (!key) throw new Error('no key in the output');
  return key;
}

function expectNoKey(key: string) {
  const serialized = JSON.stringify(envelopes);
  expect(occurrences(serialized, KEY_EVENT_MESSAGE)).toBe(1);
  expect(serialized).not.toContain(key);
  expect(serialized).not.toContain(key.slice(3, 20));
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe('service-keys under production Sentry defaults', () => {
  it("the script's printer: the key reaches stdout once and no Sentry event", async () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let key: string;
    try {
      key = await createKey(printLine);
    } finally {
      write.mockRestore();
    }
    expect(occurrences(written.join(''), key)).toBe(1);
    expectNoKey(key);
  });

  it('even printed through console.log, the key is not a breadcrumb (breadcrumbs are off)', async () => {
    const log = vi.spyOn(console, 'log');
    try {
      expectNoKey(await createKey((line) => console.log(line)));
    } finally {
      log.mockRestore();
    }
  });
});
