/**
 * The test helper that avoids the ports `fetch` refuses. Without it the app tests failed now and then with `bad port`, which
 * looks like a fault in the service but is the test machine picking port 6000 or similar.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { listenOnFetchablePort } from './helpers/app';

const open: Server[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('closes a server on a port fetch refuses and asks again, until it gets a port fetch will call', async () => {
  // A stand-in for the system's choice of port: the first two servers claim to be on bad ports (the sockets really are on free ones)
  const claimed = [6000, 6667];
  const created: Server[] = [];
  const app = {
    listen: (_port: number, host: string, cb: () => void): Server => {
      const server = createServer((_req, res) => res.end('ok'));
      created.push(server);
      const bad = claimed.shift();
      const listening = server.listen(0, host, cb);
      if (bad !== undefined) {
        const realAddress = listening.address.bind(listening);
        listening.address = () => ({ ...(realAddress() as AddressInfo), port: bad });
      }
      return listening;
    },
  };

  const server = await listenOnFetchablePort(app);
  open.push(...created);

  expect(created).toHaveLength(3);
  expect(server).toBe(created[2]);
  expect(created[0]!.listening).toBe(false);
  expect(created[1]!.listening).toBe(false);
  expect(server.listening).toBe(true);
});

it('returns the first server when its port is fine', async () => {
  const real = createServer((_req, res) => res.end('ok'));
  const server = await listenOnFetchablePort(real);
  open.push(server);
  expect(server).toBe(real);
  expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).status).toBe(200);
});
