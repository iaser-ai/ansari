import {createAdaptorServer} from '@hono/node-server';
import {readFileSync} from 'node:fs';
import type {Server} from 'node:http';
import {createAnsariHttpCompleter, type AnswerCompleter} from '../server/ansari-client.js';
import {MCP_PATH, createFetchApp} from '../server/fetch-app.js';
import type {OperationLogger, OperationRecord} from '../server/operation-log.js';
import {settingsFromEnv} from '../server/runtime-config.js';

export const DEFAULT_PORT = 3000;
export {MCP_PATH};

export type ListenOptions = {
  port?: number;
  host?: string;
  completer?: AnswerCompleter;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  html?: string;
  logger?: OperationLogger;
  requestMs?: number;
  enableJsonResponse?: boolean;
};

/** The Node adapter's logger: one JSON line on standard output. */
export function defaultOperationLogger(record: OperationRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** The Node adapter reads the built card from the deployment tree, once, at start. */
function readBuiltView(): string {
  return readFileSync(new URL('../../dist/view.html', import.meta.url), 'utf8');
}

/** Node/Docker hosting: environment, filesystem and listener around the shared fetch application. */
export function createHttpServer(options: ListenOptions = {}) {
  const settings = settingsFromEnv(process.env, options);
  const app = createFetchApp({
    completer: options.completer ?? createAnsariHttpCompleter(settings.ansari),
    html: options.html ?? readBuiltView(),
    release: settings.release,
    allowedHosts: settings.allowedHosts,
    allowedOrigins: settings.allowedOrigins,
    enableJsonResponse: settings.enableJsonResponse,
    logger: options.logger ?? defaultOperationLogger,
    requestMs: options.requestMs,
  });

  // The adapter's default createServer is Node's HTTP/1 server.
  const server = createAdaptorServer({fetch:app.fetch}) as Server;
  let closing: Promise<void> | undefined;
  return {
    server,
    release: settings.release,
    close: () => closing ??= (async () => {
      // Stop admission before closing transports. The SDK tracks modern calls;
      // closing Node connections also retires legacy calls and incomplete bodies.
      const stopped = new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      const handlersClosed = app.close();
      server.closeAllConnections();
      await Promise.all([handlersClosed,stopped]);
    })(),
  };
}

export async function listen(options: ListenOptions = {}): Promise<{port:number; close:()=>Promise<void>}> {
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const host = options.host ?? '0.0.0.0';
  const http = createHttpServer(options);
  await new Promise<void>((resolve,reject)=>{
    http.server.once('error',reject);
    http.server.listen(port,host,()=>{http.server.off('error',reject);resolve();});
  });
  const address = http.server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {port:bound,close:http.close};
}
