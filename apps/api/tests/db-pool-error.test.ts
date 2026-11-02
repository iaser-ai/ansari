import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #310: the apps/api pool must survive losing an idle connection.
// node-postgres emits `error` on the POOL when an idle client's connection dies
// (a restart, failover, pg_terminate_backend). With no listener that is an
// uncaught exception; apps/auth exited on it (spec 300), and apps/api only
// survived through Next's internal uncaughtException handler, which also logs
// the raw driver error.

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  KALEMAT_API_KEY: 'placeholder-key',
  USUL_API_TOKEN: 'placeholder-token',
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/lib/db/index');
  await closeDb();
  process.env = savedEnv;
  const { resetEnvCache } = await import('@/lib/config');
  resetEnvCache();
});

describe('lib/db/index pool', () => {
  it("listens for the pool's error event, so a dead idle client is not fatal", async () => {
    const { db, onPoolError } = await import('@/lib/db/index');
    // No connection is opened until a query runs, so this needs no database.
    const pool = db.$client as unknown as EventEmitter;

    expect(pool.listeners('error')).toContain(onPoolError);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // An EventEmitter with no 'error' listener throws here: the uncaught case.
    expect(() =>
      pool.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' }))
    ).not.toThrow();
  });

  it('the near-miss throws (proves the emit above would fail without a listener)', () => {
    expect(() => new EventEmitter().emit('error', new Error('x'))).toThrow();
  });
});

describe('onPoolError', () => {
  it('logs the error name and code only, never the message', async () => {
    const { onPoolError } = await import('@/lib/db/index');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('password authentication failed for user "secret-user"'), {
      code: '28P01',
    });

    onPoolError(error);

    expect(log).toHaveBeenCalledWith('[db] idle client error', { name: 'Error', code: '28P01' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-user');
  });
});
