// The auth database pool must survive losing an idle connection. node-postgres
// emits `error` on the POOL when an idle client's connection dies (a restart,
// failover, maintenance); with no listener that is an uncaught exception and
// apps/auth exits. Found by stopping Postgres under the built image (phase 11).
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDb, onPoolError } from '../../src/db';
import { setAuthEnv } from '../helpers/auth-db';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDb', () => {
  it("listens for the pool's error event, so a dead idle client is not fatal", () => {
    setAuthEnv('http://localhost:3100');
    const pool = createDb().$client as unknown as EventEmitter;
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
  it('logs the error name and code only, never the message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('password authentication failed for user "secret-user"'), {
      code: '28P01',
    });
    onPoolError(error);
    expect(log).toHaveBeenCalledWith('auth database: idle client error', {
      name: 'Error',
      code: '28P01',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-user');
  });
});
