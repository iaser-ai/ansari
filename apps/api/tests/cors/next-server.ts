// A real Next.js server over apps/api, for tests of what only the server adds
// (the next.config.ts headers). It runs on a temporary copy of the app, so the
// dev build never touches apps/api/.next (a `next build` output); the copy has
// the real next.config.ts, src, lib and db, and links node_modules.
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import next from 'next';

const APP_DIR = path.resolve(__dirname, '../..');
const COPIED = [
  'src',
  'lib',
  'db',
  'next.config.ts',
  'tsconfig.json',
  'package.json',
  'next-env.d.ts',
  'sentry.server.config.ts',
  'sentry.client.config.ts',
];

export interface NextTestServer {
  url: string;
  close(): Promise<void>;
}

export async function startNextServer(): Promise<NextTestServer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ansari-api-next-'));
  for (const entry of COPIED) {
    cpSync(path.join(APP_DIR, entry), path.join(dir, entry), { recursive: true });
  }
  symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

  const app = next({ dev: true, dir, quiet: true });
  const handle = app.getRequestHandler();
  await app.prepare();
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
