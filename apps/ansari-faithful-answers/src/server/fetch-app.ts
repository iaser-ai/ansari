import {hostHeaderValidation, originValidation} from '@modelcontextprotocol/hono';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {Hono} from 'hono';
import type {AnswerCompleter} from './ansari-client.js';
import {createAnsariMcpServer} from './create-server.js';
import {prepareAnswerView} from './view-artifact.js';
import {type OperationLogger, writeOperationLog} from './operation-log.js';

export const MCP_PATH = '/mcp';

/**
 * Everything the application needs, supplied explicitly. This module reads no process environment,
 * file or global, so the same code runs under Node and Cloudflare Workers.
 */
export type FetchAppOptions = {
  completer: AnswerCompleter;
  /** The built card, before release stamping. */
  html: string;
  release: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  enableJsonResponse: boolean;
  logger: OperationLogger;
  requestMs?: number;
};

export type FetchApp = {
  fetch: (request: Request) => Response | Promise<Response>;
  close: () => Promise<void>;
};

/** One Hono application over the official stateless MCP handler. Hosting adapters only supply a listener or an entry point. */
export function createFetchApp(options: FetchAppOptions): FetchApp {
  const {completer, logger, release} = options;
  const log = (record: Parameters<typeof writeOperationLog>[0]) => writeOperationLog(record, logger, release);
  // The view is prepared once: release stamping first, then the resource identity from the final bytes.
  const view = prepareAnswerView(options.html, release);
  // The official handler owns per-request transports, protocol negotiation and cleanup.
  // Both modern MCP and its older-host fallback are stateless; only the prepared view is shared.
  const mcp = createMcpHandler(
    () => createAnsariMcpServer({completer, view, logger, release, requestMs: options.requestMs}),
    {responseMode: options.enableJsonResponse ? 'json' : 'sse', onerror: () => log({event: 'mcp.error'})},
  );
  const app = new Hono();
  app.get('/health', c => c.json({ok: true, mcp: MCP_PATH, release}));
  app.use(MCP_PATH, hostHeaderValidation(options.allowedHosts));
  app.use(MCP_PATH, originValidation(options.allowedOrigins));
  app.all(MCP_PATH, c => {
    log({event: 'mcp.request', method: c.req.method});
    return mcp.fetch(c.req.raw);
  });
  app.notFound(c => c.json({error: 'not found'}, 404));
  app.onError((_, c) => {
    log({event: 'mcp.error', method: c.req.method});
    return c.json({error: 'internal error'}, 500);
  });
  return {fetch: request => app.fetch(request), close: () => mcp.close()};
}
