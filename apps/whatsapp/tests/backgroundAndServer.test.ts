/**
 * Background tasks, graceful shutdown, Sentry scrubbing and the choice of real or mock services.
 *
 * Python counterparts: FastAPI's `BackgroundTasks` and uvicorn's shutdown (neither tested in Python), the `sentry_sdk.init` block
 * of `main.py`, and `service_provider.py`.
 */
import { Agent, createServer, get, type Server } from 'node:http';
import type { Socket } from 'node:net';
import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTasks } from '../src/background';
import { Secret } from '../src/config';
import type { ErrorReport } from '../src/errorReporter';
import { runWithRequestId } from '../src/logger';
import { SENTRY_OPTIONS, scrubRequestEvent, sentryReporter } from '../src/sentry';
import { gracefulShutdown } from '../src/server';
import { AnsariClientMock, AnsariClientReal } from '../src/services/ansariClient';
import { AuthClientMock, AuthClientReal } from '../src/services/authClient';
import { createServices, type ServicesConfig } from '../src/services/createServices';
import { MetaApiServiceMock, MetaApiServiceReal } from '../src/services/metaApiService';
import { listenOnFetchablePort } from './helpers/app';
import { capturingLogger } from './helpers/network';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Timers currently keeping the process alive. */
const activeTimers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

function tasks() {
  const log = capturingLogger();
  const reports: Array<{ error: unknown; report: ErrorReport }> = [];
  const background = new BackgroundTasks({ logger: log.logger, reportError: (error, report) => reports.push({ error, report }) });
  return { background, log, reports };
}

// ---------------------------------------------------------------------------------------------------------------------
describe('BackgroundTasks', () => {
  it('starts a task after the current code, not during the call to run()', async () => {
    const { background } = tasks();
    const order: string[] = [];
    background.run(async () => {
      order.push('task');
    });
    order.push('after run()');
    await background.idle(1000);
    expect(order).toEqual(['after run()', 'task']);
  });

  it('counts a task as pending until it finishes', async () => {
    const { background } = tasks();
    let release: () => void = () => {};
    background.run(() => new Promise<void>((resolve) => (release = resolve)));
    expect(background.pending).toBe(1);
    await wait(0); // the task starts one tick after run(), and only then can it be released
    release();
    await background.idle(1000);
    expect(background.pending).toBe(0);
  });

  it('catches a task that throws: logs it, reports it with the request id, and does not reject', async () => {
    const { background, log, reports } = tasks();
    await runWithRequestId('req-77', async () => {
      background.run(async () => {
        throw new RangeError('boom');
      });
    });
    await background.idle(1000);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report).toEqual({ errorType: 'background_processing_failure', context: { request_id: 'req-77' } });
    expect(log.lines().some((line) => line.level === 'error' && line.message.includes('Unhandled error in background'))).toBe(true);
  });

  it('catches a task that throws before its first await', async () => {
    const { background, reports } = tasks();
    background.run(() => {
      throw new TypeError('synchronous');
    });
    await background.idle(1000);
    expect(reports).toHaveLength(1);
  });

  it('gives the task the request id of the request that started it', async () => {
    const { background, log } = tasks();
    await runWithRequestId('req-abc', async () => {
      background.run(async () => {
        await wait(5);
        log.logger.info('written by the task');
      });
    });
    await background.idle(1000);
    const line = log.lines().find((l) => l.message === 'written by the task') as unknown as { request_id: string };
    expect(line.request_id).toBe('req-abc');
  });

  it('keeps tasks apart: one failing does not stop another', async () => {
    const { background, reports } = tasks();
    let finished = false;
    background.run(async () => {
      throw new Error('first');
    });
    background.run(async () => {
      await wait(10);
      finished = true;
    });
    await background.idle(1000);
    expect(finished).toBe(true);
    expect(reports).toHaveLength(1);
  });

  describe('idle()', () => {
    it('is true at once when nothing is running', async () => {
      expect(await tasks().background.idle(1000)).toBe(true);
    });

    it('is true when the tasks finish within the time', async () => {
      const { background } = tasks();
      background.run(() => wait(20));
      expect(await background.idle(2000)).toBe(true);
    });

    it('is false when a task is still running at the limit, and leaves it running', async () => {
      const { background } = tasks();
      let release: () => void = () => {};
      background.run(() => new Promise<void>((resolve) => (release = resolve)));
      expect(await background.idle(30)).toBe(false);
      expect(background.pending).toBe(1);
      release();
      expect(await background.idle(1000)).toBe(true);
    });

    it('does not leave its time limit running, which would keep the process alive', async () => {
      const { background } = tasks();
      const before = activeTimers();
      background.run(() => wait(5));
      await background.idle(60_000);
      expect(activeTimers()).toBe(before);
    });

    it('does not leave its time limit running when it gives up either', async () => {
      const { background } = tasks();
      let release: () => void = () => {};
      background.run(() => new Promise<void>((resolve) => (release = resolve)));
      const before = activeTimers();
      await background.idle(20);
      expect(activeTimers()).toBe(before);
      release();
      await background.idle(1000);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('gracefulShutdown', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function listening(handler?: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
    const created = createServer(handler ?? ((_req, res) => res.end('ok')));
    const server = await listenOnFetchablePort(created);
    servers.push(server);
    const address = server.address();
    return { server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` };
  }

  it('stops accepting new connections', async () => {
    const { server, url } = await listening();
    const { background, log } = tasks();
    await gracefulShutdown({ server, background, logger: log.logger, graceMs: 200 });
    await expect(fetch(url)).rejects.toThrow();
  });

  it('waits for a running task before it finishes', async () => {
    const { server } = await listening();
    const { background, log } = tasks();
    let done = false;
    background.run(async () => {
      await wait(60);
      done = true;
    });
    await gracefulShutdown({ server, background, logger: log.logger, graceMs: 2000 });
    expect(done).toBe(true);
    expect(log.text()).toContain('Shutdown complete');
  });

  it('gives up on a task that outlasts the grace period, and says so', async () => {
    const { server } = await listening();
    const { background, log } = tasks();
    background.run(() => new Promise<void>(() => {})); // never finishes
    const started = Date.now();
    await gracefulShutdown({ server, background, logger: log.logger, graceMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(log.text()).toContain('Gave up on 1 task(s)');
  });

  it('does not hang on an idle keep-alive connection', async () => {
    const { server, url } = await listening();
    const { background, log } = tasks();
    await fetch(url, { headers: { Connection: 'keep-alive' } }); // leaves a connection open on the client side
    await Promise.race([
      gracefulShutdown({ server, background, logger: log.logger, graceMs: 100 }),
      wait(3000).then(() => {
        throw new Error('shutdown hung on a keep-alive connection');
      }),
    ]);
  });

  // Without this, an idle connection a browser or proxy keeps open would stay until the grace period ended
  it('closes an idle keep-alive connection at once, without waiting for the running tasks', async () => {
    const { server, url } = await listening();
    const { background, log } = tasks();
    const agent = new Agent({ keepAlive: true });
    try {
      // The socket is only reachable while the request is open: once the response ends it is handed back to the agent
      const socket = await new Promise<Socket>((resolve) => {
        const request = get(url, { agent }, (response) => response.resume());
        request.once('socket', (opened) => {
          request.once('response', () => resolve(opened));
        });
      });
      await wait(20); // let the response finish, so the connection is idle and kept alive
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      background.run(() => new Promise<void>(() => {})); // a task that never ends keeps the grace period running

      const shutdown = gracefulShutdown({ server, background, logger: log.logger, graceMs: 600 });
      const outcome = await Promise.race([closed.then(() => 'closed'), wait(250).then(() => 'still open')]);
      await shutdown;

      expect(outcome).toBe('closed');
    } finally {
      agent.destroy();
    }
  });

  it('does not hang on a client that never finishes its request', async () => {
    const { server, url } = await listening(() => {
      /* never answers */
    });
    const { background, log } = tasks();
    const pending = fetch(url).catch(() => 'closed');
    await wait(30);
    await Promise.race([
      gracefulShutdown({ server, background, logger: log.logger, graceMs: 50 }),
      wait(3000).then(() => {
        throw new Error('shutdown hung on an unanswered request');
      }),
    ]);
    expect(await pending).toBe('closed');
  });

  it('flushes last, after the tasks', async () => {
    const { server } = await listening();
    const { background, log } = tasks();
    const order: string[] = [];
    background.run(async () => {
      await wait(30);
      order.push('task');
    });
    await gracefulShutdown({
      server,
      background,
      logger: log.logger,
      graceMs: 2000,
      flush: async () => {
        order.push('flush');
      },
    });
    expect(order).toEqual(['task', 'flush']);
  });

  it('does not throw when the flush fails, and logs it', async () => {
    const { server } = await listening();
    const { background, log } = tasks();
    await expect(
      gracefulShutdown({
        server,
        background,
        logger: log.logger,
        graceMs: 100,
        flush: async () => {
          throw new Error('sentry is down');
        },
      }),
    ).resolves.toBeUndefined();
    expect(log.text()).toContain('Could not flush error reports');
    expect(log.text()).toContain('Shutdown complete');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Sentry', () => {
  describe('scrubRequestEvent', () => {
    it('keeps the method, the URL without its query string, and only the harmless headers', () => {
      const event = scrubRequestEvent({
        request: {
          method: 'GET',
          url: 'https://whatsapp.example/whatsapp/v3?hub.verify_token=SECRETTOKEN&hub.challenge=c',
          headers: {
            Host: 'whatsapp.example',
            'User-Agent': 'facebookexternalua',
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': 'sha256=SIGNATURE',
            Authorization: 'Bearer BEARER',
            Cookie: 'a=COOKIE',
          },
          data: '{"text":"BODYTEXT"}',
          query_string: 'hub.verify_token=SECRETTOKEN',
        },
      });
      expect(Object.keys(event.request!).sort()).toEqual(['headers', 'method', 'url']);
      expect(event.request!.url).toBe('https://whatsapp.example/whatsapp/v3');
      expect(Object.keys(event.request!.headers!).sort()).toEqual(['Content-Type', 'Host', 'User-Agent']);
      const text = JSON.stringify(event);
      for (const marker of ['SECRETTOKEN', 'SIGNATURE', 'BEARER', 'COOKIE', 'BODYTEXT']) expect(text).not.toContain(marker);
    });

    it('returns an event with no request untouched', () => {
      const event = { message: 'hi' };
      expect(scrubRequestEvent(event)).toEqual({ message: 'hi' });
    });

    it('copes with a request that has no headers or no URL', () => {
      expect(scrubRequestEvent({ request: { method: 'POST' } }).request).toEqual({ method: 'POST', url: undefined, headers: {} });
    });

    it('matches header names in any case', () => {
      const event = scrubRequestEvent({ request: { headers: { host: 'h', HOST2: 'x', 'USER-AGENT': 'u', authorization: 'a' } } });
      expect(Object.keys(event.request!.headers!).sort()).toEqual(['USER-AGENT', 'host']);
    });
  });

  describe('the options', () => {
    it('do not send personal data by default, keep no breadcrumbs, and scrub every event', () => {
      expect(SENTRY_OPTIONS.sendDefaultPii).toBe(false);
      expect(SENTRY_OPTIONS.maxBreadcrumbs).toBe(0);
      expect(SENTRY_OPTIONS.beforeBreadcrumb()).toBeNull();
      expect(SENTRY_OPTIONS.beforeSend).toBe(scrubRequestEvent);
    });
  });

  describe('sentryReporter, through a real client with a spy transport', () => {
    afterEach(async () => {
      await Sentry.close();
    });

    /** The parts of a Sentry event these tests read. */
    interface SentEvent {
      tags: Record<string, string>;
      contexts?: { details?: Record<string, unknown> };
      exception: { values: Array<{ value: string }> };
    }

    async function capture(run: () => void): Promise<SentEvent[]> {
      const envelopes: unknown[] = [];
      Sentry.init({
        dsn: 'https://public@o0.ingest.sentry.io/0',
        environment: 'test',
        ...SENTRY_OPTIONS,
        transport: () => ({
          send: async (envelope) => {
            envelopes.push(envelope);
            return {};
          },
          flush: async () => true,
        }),
      });
      run();
      await Sentry.flush(2000);
      return envelopes
        .flatMap((e) => (e as [unknown, Array<[{ type: string }, SentEvent]>])[1])
        .filter(([header]) => header.type === 'event')
        .map(([, event]) => event);
    }

    it('sends one event tagged with the error type and carrying the context', async () => {
      const events = await capture(() =>
        sentryReporter(new Error('a failure'), { errorType: 'meta_api_failure', context: { request_id: 'req-1', status_code: 500 } }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.tags).toMatchObject({ error_type: 'meta_api_failure' });
      expect(events[0]!.contexts?.details).toEqual({ request_id: 'req-1', status_code: 500 });
      expect(events[0]!.exception.values[0]!.value).toBe('a failure');
    });

    it('does not let one event\'s tag leak onto the next', async () => {
      const events = await capture(() => {
        sentryReporter(new Error('one'), { errorType: 'first' });
        sentryReporter(new Error('two'), { errorType: 'second', context: { request_id: 'r' } });
      });
      expect(events.map((e) => e.tags.error_type).sort()).toEqual(['first', 'second']);
      const first = events.find((e) => e.tags.error_type === 'first')!;
      expect(first.contexts?.details).toBeUndefined();
    });

    it('sends no-error values too (a thrown string or null) rather than failing', async () => {
      const events = await capture(() => {
        sentryReporter('just a string', { errorType: 'odd' });
        sentryReporter(null, { errorType: 'odd2' });
      });
      expect(events).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('createServices', () => {
  const real: ServicesConfig = {
    MOCK_ANSARI_CLIENT: false,
    MOCK_AUTH_CLIENT: false,
    MOCK_AUTH_TOKEN: undefined,
    MOCK_META_API: false,
    BACKEND_SERVER_URL: 'http://api.test',
    AUTH_SERVER_URL: 'http://auth.test',
    AUTH_WHATSAPP_API_KEY: new Secret('key'),
    META_API_URL: 'https://graph.facebook.com/v26.0/1/messages',
    META_ACCESS_TOKEN_FROM_SYS_USER: new Secret('token'),
    ENVIRONMENT: 'production',
  };
  const log = () => capturingLogger().logger;

  it('uses the real client for each service when no mock flag is on', () => {
    const services = createServices(real, log(), () => {});
    expect(services.ansariClient).toBeInstanceOf(AnsariClientReal);
    expect(services.authClient).toBeInstanceOf(AuthClientReal);
    expect(services.metaApi).toBeInstanceOf(MetaApiServiceReal);
  });

  it('uses the mock for exactly the services whose flag is on', () => {
    const services = createServices(
      { ...real, MOCK_ANSARI_CLIENT: true, MOCK_META_API: true, ENVIRONMENT: 'development' },
      log(),
      () => {},
    );
    expect(services.ansariClient).toBeInstanceOf(AnsariClientMock);
    expect(services.authClient).toBeInstanceOf(AuthClientReal);
    expect(services.metaApi).toBeInstanceOf(MetaApiServiceMock);
  });

  // Each real client takes the global `fetch` when it is built, so stubbing it first records where each one calls
  it('points each real client at its own address', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response('{}', { status: 200 });
    });
    try {
      const services = createServices(real, log(), () => {});
      await services.authClient.getToken('US.1').catch(() => {});
      await services.ansariClient.getLastThreadInfo('t').catch(() => {});
      await services.metaApi.sendMessage('US.1', ['hi']).catch(() => {});
    } finally {
      vi.unstubAllGlobals();
    }
    expect(urls).toEqual([
      'http://auth.test/api/whatsapp/session',
      'http://api.test/api/v2/threads',
      'https://graph.facebook.com/v26.0/1/messages',
    ]);
  });

  it('gives the mock auth client the configured token, so every user shares one real account', async () => {
    const { authClient } = createServices(
      { ...real, MOCK_AUTH_CLIENT: true, MOCK_AUTH_TOKEN: new Secret('a.real.jwt'), ENVIRONMENT: 'development' },
      log(),
      () => {},
    );
    expect(authClient).toBeInstanceOf(AuthClientMock);
    expect(await authClient.getToken('US.1')).toBe('a.real.jwt');
    expect(await authClient.getToken('US.2')).toBe('a.real.jwt');
  });

  it('gives each user a token of their own when no mock token is configured', async () => {
    const { authClient } = createServices({ ...real, MOCK_AUTH_CLIENT: true, ENVIRONMENT: 'development' }, log(), () => {});
    expect(await authClient.getToken('US.1')).not.toBe(await authClient.getToken('US.2'));
  });
});
