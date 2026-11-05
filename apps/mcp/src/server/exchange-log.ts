// What one MCP exchange looked like on the wire, for first-load diagnosis (#335): which method a host called,
// which card address it read and whether that address is the one served now, and how the response stream ended.
// Only fixed fields are derived from the request; no question, answer or other parameter value is kept.
//
// Observation never sits on the request path: the request is inspected from a copy, alongside the handler, up to a
// byte bound, and any failure to inspect is recorded as such instead of affecting the exchange.

/** Request bytes inspected at most; MCP requests from hosts are a few kilobytes. Larger bodies are recorded as `oversize`. */
export const MAX_INSPECTED_BODY = 65_536;
/** Response bytes kept for decoding a JSON-RPC error. A successful card read is larger and needs no decoding. */
const MAX_DECODED_RESPONSE = 65_536;
const TOKEN = /^[A-Za-z0-9 ._:/@+-]{1,80}$/;
const UI_URI = /^ui:\/\/[A-Za-z0-9._/-]{1,200}$/;

export type RpcSummary = {
  rpc: string;
  requestId?: string | number;
  uri?: string;
  uriCurrent?: boolean;
  client?: string;
  clientVersion?: string;
  protocol?: string;
  tool?: string;
};

/**
 * How the response stream ended on this side: `drained` (the transport read it to the end), `cancelled` (the reader
 * stopped early, as when the client goes away) or `failed`. Neither says the host received or rendered it.
 */
export type StreamOutcome = 'drained' | 'cancelled' | 'failed';
export type ExchangeEnd = {
  stream: StreamOutcome;
  bytes: number;
  /** The JSON-RPC error code, when the response decoded as JSON-RPC within the kept bytes. */
  errorCode?: number;
  /** Whether the kept bytes decoded as JSON-RPC at all; `false` for a body too large to keep or not JSON-RPC. */
  decoded: boolean;
};

const token = (value: unknown): string | undefined => typeof value === 'string' ? (TOKEN.test(value) ? value : 'other') : undefined;
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function summarizeMessage(message: Record<string, unknown>, currentUri: string): RpcSummary {
  if (typeof message.method !== 'string') return {rpc: 'result' in message || 'error' in message ? 'response' : 'unparsed'};
  const summary: RpcSummary = {rpc: token(message.method)!};
  if (typeof message.id === 'number' || (typeof message.id === 'string' && TOKEN.test(message.id))) summary.requestId = message.id;
  const params = record(message.params);
  if (message.method === 'initialize') {
    const clientInfo = record(params.clientInfo);
    summary.client = token(clientInfo.name);
    summary.clientVersion = token(clientInfo.version);
    summary.protocol = token(params.protocolVersion);
  } else if (message.method === 'tools/call') {
    summary.tool = token(params.name);
  } else if (message.method === 'resources/read') {
    const uri = typeof params.uri === 'string' && UI_URI.test(params.uri) ? params.uri : 'other';
    summary.uri = uri;
    summary.uriCurrent = uri === currentUri;
  }
  return summary;
}

/** The JSON-RPC method(s) of a request body, with the few identifying fields that tell first-load paths apart. */
export function summarizeRpc(body: string, currentUri: string): RpcSummary {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return {rpc: 'unparsed'}; }
  if (Array.isArray(parsed)) {
    const messages = parsed.slice(0, 5).map(item => summarizeMessage(record(item), currentUri));
    return {...messages[0], rpc: messages.map(message => message.rpc).join(',') || 'empty'};
  }
  return summarizeMessage(record(parsed), currentUri);
}

/**
 * Reads a stream up to `limit` bytes. Stops and cancels as soon as the limit is passed, whatever the stream's
 * declared length, so an absent or wrong Content-Length cannot make it read more.
 */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<{text: string} | {exceeded: true}> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return {exceeded: true};
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return {text: new TextDecoder().decode(bytes)};
}

/**
 * Starts inspecting a request from a copy and returns at once; the caller hands the original to the handler without
 * waiting. Must be called before the original body is read. Never rejects.
 */
export function inspectRequest(request: Request, currentUri: string): Promise<RpcSummary> {
  if (request.method !== 'POST') return Promise.resolve({rpc: 'none'});
  if (request.body === null) return Promise.resolve({rpc: 'empty'});
  const copy = request.clone().body!;
  return readBounded(copy, MAX_INSPECTED_BODY).then(
    read => 'exceeded' in read ? {rpc: 'oversize'} : summarizeRpc(read.text, currentUri),
    () => ({rpc: 'unread'}),
  );
}

/** The first JSON-RPC error code in a JSON or SSE response body, decoded rather than pattern-matched. */
function decodeRpcError(text: string, contentType: string): {decoded: boolean; errorCode?: number} {
  const payloads = contentType.includes('text/event-stream')
    ? text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
    : [text];
  let decoded = false;
  for (const payload of payloads) {
    let message: unknown;
    try { message = JSON.parse(payload); } catch { continue; }
    for (const item of Array.isArray(message) ? message : [message]) {
      const value = record(item);
      if (value.jsonrpc !== '2.0') continue;
      decoded = true;
      const code = record(value.error).code;
      if (typeof code === 'number') return {decoded, errorCode: code};
    }
  }
  return {decoded};
}

/**
 * Passes the response through unchanged while counting what the transport reads, and reports once how that stream
 * ended. Responses small enough to keep are decoded for a JSON-RPC error, which MCP carries inside an HTTP 200.
 */
export function observeResponse(response: Response, done: (end: ExchangeEnd) => void): Response {
  const contentType = response.headers.get('content-type') ?? '';
  let ended = false;
  let bytes = 0;
  const kept: Uint8Array[] = [];
  const finish = (stream: StreamOutcome) => {
    if (ended) return;
    ended = true;
    if (bytes > MAX_DECODED_RESPONSE || bytes === 0) { done({stream, bytes, decoded: false}); return; }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of kept) { all.set(chunk, offset); offset += chunk.byteLength; }
    done({stream, bytes, ...decodeRpcError(new TextDecoder().decode(all), contentType)});
  };
  if (response.body === null) { finish('drained'); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const {done: last, value} = await reader.read();
        if (last) { finish('drained'); controller.close(); return; }
        bytes += value.byteLength;
        if (bytes <= MAX_DECODED_RESPONSE) kept.push(value);
        else kept.length = 0;
        controller.enqueue(value);
      } catch (error) {
        finish('failed');
        controller.error(error);
      }
    },
    cancel(reason) {
      finish('cancelled');
      return reader.cancel(reason);
    },
  });
  return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}

/** An error's name and code only: never its message, which can carry request content. */
export function errorIdentity(error: unknown): {name?: string; code?: string | number} {
  const value = record(error);
  const code = value.code;
  return {
    name: error instanceof Error ? token(error.name) : undefined,
    ...(typeof code === 'number' ? {code} : typeof code === 'string' ? {code: token(code)} : {}),
  };
}
