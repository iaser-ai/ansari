import {hostHeaderValidation} from '@modelcontextprotocol/hono';
import {createMcpFetchApp} from '@saga-a2ui/react-mcp-stack/server/http';
import {Hono} from 'hono';
import type {AnswerCompleter} from './ansari-client.js';
import {HANDLER_BOUND_MS, createAnsariMcpServer} from './create-server.js';
import {errorIdentity, inspectRequest, observeResponse, readBounded} from './exchange-log.js';
import {VIEW_DIAGNOSTICS_PATH, prepareAnswerView} from './view-artifact.js';
import {MAX_VIEW_REPORT_BYTES, VIEW_REPORTS_PER_MINUTE, originHost, parseViewReport} from './view-report.js';
import {type OperationLogger, type OperationRecord, writeOperationLog} from './operation-log.js';

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
  /** Each request's budget, from admission. Defaults to the tool's declared handler bound. */
  requestMs?: number;
  /** Dev-only: the public origin a diagnostic card reports its milestones to (see `VIEW_DIAGNOSTICS_PATH`). */
  viewDiagnosticsOrigin?: string;
  /** `debug` writes the first-load measurement records too; the default `info` writes only the operational ones. */
  logLevel?: 'info' | 'debug';
};

export type FetchApp = {
  fetch: (request: Request) => Response | Promise<Response>;
  close: () => Promise<void>;
};

/**
 * The SDK's fetch app serves `/mcp`: Host and Origin admission, body bounds, the request budget and lifetime, and the
 * official stateless handler. Around it, this application adds only its own routes (`/health`, and the Dev-only
 * diagnostics beacon) and its logs. Hosting adapters only supply a listener or an entry point.
 */
export function createFetchApp(options: FetchAppOptions): FetchApp {
  const {completer, logger, release} = options;
  // Measuring adds `debug` records and inspects each exchange; otherwise the exchange is passed straight through.
  const measuring = options.logLevel === 'debug';
  const log = (record: OperationRecord) => {
    if (record.level !== 'debug' || measuring) writeOperationLog(record, logger, release);
  };
  // The view is prepared once, release-stamped, at its compatibility-line address.
  const view = prepareAnswerView(options.html, release, options.viewDiagnosticsOrigin);
  // Both modern MCP and its older-host fallback are stateless; only the prepared view is shared.
  const mcp = createMcpFetchApp({
    createServer: lifetime => createAnsariMcpServer({completer, view, logger, release, lifetime}),
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    path: MCP_PATH,
    responseMode: options.enableJsonResponse ? 'json' : 'sse',
    // The request budget is the tool's declared bound, not the SDK's 10 s default, which would cut a long answer short.
    budgets: {requestMs: options.requestMs ?? HANDLER_BOUND_MS},
    onFailure: kind => log({level: 'error', event: 'mcp.error', kind}),
  });
  const app = new Hono();
  app.get('/health', c => c.json({ok: true, mcp: MCP_PATH, release}));
  // The exact card this instance serves: a diagnostic card differs from the closed one in bytes and permissions, not address.
  log({level: 'debug', event: 'view.prepared', at: Date.now(), uri: view.uri, bytes: new TextEncoder().encode(view.html).byteLength, diagnostics: options.viewDiagnosticsOrigin !== undefined, connectDomains: view.csp.connectDomains.join(',')});
  app.all(MCP_PATH, async c => {
    log({level: 'info', event: 'mcp.request', method: c.req.method});
    if (!measuring) return mcp.fetch(c.req.raw);
    // While measuring, one line when the request has been inspected and one when its response stream ends, joined by
    // `rid`: which method a host called, which card address it read, and how the response stream ended (#335).
    // Inspection reads a copy alongside the handler and never holds up or alters the exchange.
    const started = Date.now();
    const rid = crypto.randomUUID().slice(0, 8);
    const inspected = inspectRequest(c.req.raw, view.uri);
    void inspected.then(summary => log({level: 'debug', event: 'mcp.rpc', at: started, rid, ...summary}));
    const response = await mcp.fetch(c.req.raw);
    const headersMs = Date.now() - started;
    return observeResponse(response, end => {
      const ms = Date.now() - started;
      void inspected.then(summary => log({level: 'debug', event: 'mcp.response', at: Date.now(), rid, rpc: summary.rpc, status: response.status, headersMs, ms, ...end}));
    });
  });
  if (options.viewDiagnosticsOrigin !== undefined) {
    app.use(VIEW_DIAGNOSTICS_PATH, hostHeaderValidation(options.allowedHosts));
    let windowStart = 0;
    let windowCount = 0;
    // A beacon from a sandboxed card: unauthenticated, client-authored and only as trustworthy as the card that sent
    // it. Bounded in size and rate; nothing is read back.
    app.post(VIEW_DIAGNOSTICS_PATH, async c => {
      c.header('access-control-allow-origin', '*');
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; windowCount = 0; }
      if (++windowCount > VIEW_REPORTS_PER_MINUTE) {
        if (windowCount === VIEW_REPORTS_PER_MINUTE + 1) log({level: 'warn', event: 'view.report.limited', perMinute: VIEW_REPORTS_PER_MINUTE});
        return c.body(null, 429);
      }
      const origin = originHost(c.req.header('origin') ?? null);
      const read = c.req.raw.body === null ? {text: ''} : await readBounded(c.req.raw.body, MAX_VIEW_REPORT_BYTES).catch(() => ({exceeded: true as const}));
      if ('exceeded' in read) {
        log({level: 'warn', event: 'view.report.invalid', reason: 'size', origin});
        return c.body(null, 413);
      }
      const report = parseViewReport(read.text);
      if (report === undefined) {
        log({level: 'warn', event: 'view.report.invalid', reason: 'shape', origin});
        return c.body(null, 400);
      }
      log({level: 'debug', event: 'view.report', at: now, clientAuthored: true, origin, ...report});
      return c.body(null, 204);
    });
  }
  app.notFound(c => c.json({error: 'not found'}, 404));
  app.onError((error, c) => {
    log({level: 'error', event: 'mcp.error', method: c.req.method, ...errorIdentity(error)});
    return c.json({error: 'internal error'}, 500);
  });
  return {fetch: request => app.fetch(request), close: () => mcp.close()};
}
