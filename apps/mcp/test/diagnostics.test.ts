import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFetchApp} from '../src/server/fetch-app.ts';
import type {OperationRecord} from '../src/server/operation-log.ts';
import {settingsFromEnv} from '../src/server/runtime-config.ts';
import {MAX_INSPECTED_BODY, readBounded} from '../src/server/exchange-log.ts';
import {VIEW_DIAGNOSTICS_META, VIEW_DIAGNOSTICS_PATH, prepareAnswerView} from '../src/server/view-artifact.ts';
import {VIEW_REPORTS_PER_MINUTE} from '../src/server/view-report.ts';

// First-load diagnosis (#335): what the server and the card record, and the Dev-only beacon channel.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'">`;
const html = `<html><head>${CSP}</head><body data-release="0">synthetic card ${'x'.repeat(4096)}</body></html>`;
const QUESTION = 'PRIVATE_QUESTION_CANARY';
const ANSWER = 'PRIVATE_ANSWER_CANARY';
const STALE = 'ui://views/answer-card.a0cf6be6ed3f0fc75f083280d39ee589.html';
const ORIGIN = 'https://dev.example';

function harness(env: Record<string, string> = {}, complete: () => Promise<string> = async () => ANSWER) {
  const logs: OperationRecord[] = [];
  const app = createFetchApp({...settingsFromEnv(env), html, logger: record => logs.push(record), completer: {complete}});
  let id = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) => app.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25'},
    body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params}),
  }));
  const beacon = (body: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${VIEW_DIAGNOSTICS_PATH}`, {
    method: 'POST', headers: {host: 'localhost', 'content-type': 'text/plain', origin: 'https://sandbox.host.example', ...headers}, body, duplex: 'half',
  } as RequestInit));
  return {app, logs, rpc, beacon};
}

/** A streamed body of `size` bytes with no Content-Length, delivered in 4 KiB chunks. */
function streamOf(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({pull(controller) {
    if (sent >= size) { controller.close(); return; }
    const chunk = new TextEncoder().encode('x'.repeat(Math.min(4096, size - sent)));
    sent += chunk.byteLength;
    controller.enqueue(chunk);
  }});
}

const settled = async (response: Response) => { await response.text(); await new Promise(resolve => setTimeout(resolve, 0)); };
const byRid = (logs: OperationRecord[], event: string, rpc: string) => logs.filter(r => r.event === event && r.rpc === rpc);

const MEASURING = {MCP_LOG_LEVEL: 'debug'};

test('each MCP exchange records its method, card address, outcome, size and timing without content', async () => {
  const {app, logs, rpc} = harness(MEASURING);
  try {
    const listed = await rpc('tools/list');
    const uri = (JSON.parse((await listed.text()).replace(/^[\s\S]*?data: /, '')) as {result: {tools: {_meta: {ui: {resourceUri: string}}}[]}}).result.tools[0]._meta.ui.resourceUri;
    await settled(await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'probe-host', version: '9.1'}}));
    await settled(await rpc('resources/read', {uri}));
    await settled(await rpc('resources/read', {uri: STALE}));
    await settled(await rpc('tools/call', {name: 'answer_islamic_question', arguments: {question: QUESTION}}));

    const [current, stale] = byRid(logs, 'mcp.rpc', 'resources/read');
    assert.equal(current.uri, uri);
    assert.equal(current.uriCurrent, true);
    assert.equal(stale.uri, STALE);
    assert.equal(stale.uriCurrent, false, 'a card address from an earlier deploy is visible as such');
    const initialize = byRid(logs, 'mcp.rpc', 'initialize')[0];
    assert.equal(initialize.client, 'probe-host');
    assert.equal(initialize.clientVersion, '9.1');
    assert.equal(initialize.protocol, '2025-06-18');
    assert.equal(byRid(logs, 'mcp.rpc', 'tools/call')[0].tool, 'answer_islamic_question');

    const [read, missing] = byRid(logs, 'mcp.response', 'resources/read');
    assert.equal(read.rid, current.rid, 'request and response lines share one id');
    assert.equal(read.status, 200);
    assert.equal(read.stream, 'drained', 'the transport read the whole stream; delivery to the host is not claimed');
    assert.equal(read.decoded, true);
    assert.equal(read.errorCode, undefined);
    assert.ok((read.bytes as number) > html.length, 'the card read reports the bytes actually sent');
    assert.equal(typeof read.ms, 'number');
    assert.equal(typeof read.headersMs, 'number');
    assert.equal(missing.status, 200);
    assert.equal(missing.errorCode, -32602, 'a stale card read is a decoded JSON-RPC error inside an HTTP 200');
    const prepared = logs.find(r => r.event === 'view.prepared')!;
    assert.equal(prepared.uri, uri, 'the served card identity is recorded once at start');
    assert.equal(prepared.diagnostics, false);
    assert.equal(prepared.connectDomains, '');
    for (const record of logs.filter(r => r.event === 'mcp.request')) assert.equal(record.method, 'POST', 'the operational request line keeps the HTTP verb');
    for (const event of ['mcp.rpc', 'mcp.response', 'view.prepared']) assert.ok(logs.filter(r => r.event === event).every(r => r.level === 'debug'), event);
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes(QUESTION) && !serialized.includes(ANSWER), 'no question or answer text is logged');
  } finally { await app.close(); }
});

test('a client that hangs up mid-response is recorded as cancelled', async () => {
  let release!: () => void;
  const {app, logs, rpc} = harness(MEASURING, () => new Promise(resolve => { release = () => resolve(ANSWER); }));
  try {
    const response = await rpc('tools/call', {name: 'answer_islamic_question', arguments: {question: QUESTION}});
    assert.equal(response.headers.get('content-type')?.startsWith('text/event-stream'), true);
    await response.body!.cancel();
    release();
    for (let waited = 0; !byRid(logs, 'mcp.response', 'tools/call').length && waited < 1000; waited += 10) await new Promise(r => setTimeout(r, 10));
    assert.equal(byRid(logs, 'mcp.response', 'tools/call')[0]?.stream, 'cancelled');
  } finally { await app.close(); }
});

test('an unparsable request is recorded as such', async () => {
  const {app, logs} = harness(MEASURING);
  try {
    const response = await app.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: {host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body: '{not json',
    }));
    await response.text();
    const request = logs.find(r => r.event === 'mcp.rpc')!;
    assert.equal(request.rpc, 'unparsed');
    const response_ = logs.find(r => r.event === 'mcp.response')!;
    assert.equal((response_.status as number) >= 400 || typeof response_.errorCode === 'number', true);
  } finally { await app.close(); }
});

/** One complete exchange: handshake, listing, card read, tool call. */
async function exchange(rpc: ReturnType<typeof harness>['rpc']) {
  await settled(await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'probe-host', version: '9.1'}}));
  const listed = await rpc('tools/list');
  const uri = (JSON.parse((await listed.text()).replace(/^[\s\S]*?data: /, '')) as {result: {tools: {_meta: {ui: {resourceUri: string}}}[]}}).result.tools[0]._meta.ui.resourceUri;
  await settled(await rpc('resources/read', {uri}));
  await settled(await rpc('tools/call', {name: 'answer_islamic_question', arguments: {question: QUESTION}}));
  for (let waited = 0; waited < 50; waited += 10) await new Promise(r => setTimeout(r, 10));
}

test('a deployment that is not measuring writes only the operational records', async () => {
  const operational = harness();
  const measured = harness(MEASURING);
  try {
    await exchange(operational.rpc);
    await exchange(measured.rpc);
    // The records a deployment without the experiment writes, each now with a level.
    assert.deepEqual(operational.logs.map(r => [r.level, r.event, Object.keys(r).sort().join(',')]), [
      ...['initialize', 'tools/list', 'resources/read'].map(() => ['info', 'mcp.request', 'event,level,method,release']),
      ['info', 'mcp.request', 'event,level,method,release'],
      ['info', 'source.start', 'event,level,method,release'],
      ['info', 'source.complete', 'answerBytes,answerSha256,event,level,method,release'],
    ]);
    assert.deepEqual(measured.logs.filter(r => r.level !== 'debug'), operational.logs, 'dropping the debug lines leaves the same records');
    assert.ok(measured.logs.some(r => r.level === 'debug'));
    const levels = new Set(['error', 'warn', 'info', 'debug']);
    assert.ok([...operational.logs, ...measured.logs].every(r => levels.has(r.level)), 'every record carries a level');
  } finally { await operational.app.close(); await measured.app.close(); }
});

test('an upstream failure is logged at error level without its message', async () => {
  const {app, logs, rpc} = harness({}, async () => { throw new Error(QUESTION); });
  try {
    await settled(await rpc('tools/call', {name: 'answer_islamic_question', arguments: {question: QUESTION}}));
    assert.deepEqual(logs.filter(r => r.level === 'error').map(r => r.event), ['source.error']);
    assert.ok(!JSON.stringify(logs).includes(QUESTION), 'neither the question nor the error message is logged');
  } finally { await app.close(); }
});

test('the log level is info unless measuring, and contradictions stop startup', () => {
  assert.equal(settingsFromEnv({}).logLevel, 'info');
  assert.equal(settingsFromEnv({MCP_LOG_LEVEL: 'debug'}).logLevel, 'debug');
  assert.equal(settingsFromEnv({MCP_VIEW_DIAGNOSTICS_ORIGIN: ORIGIN}).logLevel, 'debug', 'a diagnostic card implies debug');
  assert.throws(() => settingsFromEnv({MCP_LOG_LEVEL: 'verbose'}), /MCP_LOG_LEVEL/);
  assert.throws(() => settingsFromEnv({MCP_LOG_LEVEL: 'info', MCP_VIEW_DIAGNOSTICS_ORIGIN: ORIGIN}), /MCP_LOG_LEVEL=info/);
});

test('without a diagnostics origin the card, its address and its permissions are unchanged', async () => {
  assert.equal(settingsFromEnv({}).viewDiagnosticsOrigin, undefined);
  const plain = prepareAnswerView(html, 'r1');
  assert.deepEqual(prepareAnswerView(html, 'r1', undefined), plain);
  assert.ok(!plain.html.includes(VIEW_DIAGNOSTICS_META));
  assert.ok(plain.html.includes("connect-src 'none'"));
  assert.deepEqual(plain.csp.connectDomains, []);
  const {app, beacon} = harness();
  try { assert.equal((await beacon('{}')).status, 404, 'no beacon route unless diagnostics are configured'); } finally { await app.close(); }
});

test('a diagnostics origin opens exactly one connect origin and stamps the beacon address', () => {
  const settings = settingsFromEnv({MCP_VIEW_DIAGNOSTICS_ORIGIN: `${ORIGIN}/`});
  assert.equal(settings.viewDiagnosticsOrigin, ORIGIN);
  const view = prepareAnswerView(html, 'r1', ORIGIN);
  assert.ok(view.html.startsWith(`<html><head><meta name="${VIEW_DIAGNOSTICS_META}" content="${ORIGIN}${VIEW_DIAGNOSTICS_PATH}">`), 'the address precedes everything in head, so the early script can read it');
  assert.ok(view.html.includes(`connect-src ${ORIGIN};`));
  assert.ok(!view.html.includes("connect-src 'none'"));
  assert.deepEqual(view.csp.connectDomains, [ORIGIN]);
  // Same compatibility line, so the same address; the bytes and permissions are what differ from the closed card.
  const closed = prepareAnswerView(html, 'r1');
  assert.equal(view.uri, closed.uri);
  assert.notEqual(view.html, closed.html);
  assert.deepEqual(closed.csp.connectDomains, []);
  for (const bad of ['http://dev.example', 'https://dev.example/path', 'https://user@dev.example', 'not a url', 'https://dev.example?x=1']) {
    assert.throws(() => settingsFromEnv({MCP_VIEW_DIAGNOSTICS_ORIGIN: bad}), /MCP_VIEW_DIAGNOSTICS_ORIGIN/, bad);
  }
  assert.equal(settingsFromEnv({MCP_VIEW_DIAGNOSTICS_ORIGIN: 'http://127.0.0.1:8080'}).viewDiagnosticsOrigin, 'http://127.0.0.1:8080');
  assert.throws(() => prepareAnswerView('<html><body></body></html>', 'r1', ORIGIN), /connect-src/, 'a card without the closed connect rule fails loudly');
});

test('the beacon accepts only the fixed report shape and logs it without free text', async () => {
  const {app, logs, beacon} = harness({MCP_VIEW_DIAGNOSTICS_ORIGIN: ORIGIN});
  try {
    const report = {
      v: 1, id: 'abc123def456', release: 'r1', reason: 'pagehide', visibility: 'hidden', host: 'Claude',
      marks: {script: 12.4, main: 410.9, context: 980.2, fonts: 1300.1, unknownMark: 5},
      errors: [{type: 'csp', directive: 'connect-src', blocked: 'https'}, {type: 'error', name: 'TypeError', message: ANSWER}],
      failure: 'connect', extra: ANSWER,
    };
    const accepted = await beacon(JSON.stringify(report));
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get('access-control-allow-origin'), '*');
    const logged = logs.find(r => r.event === 'view.report')!;
    assert.equal(logged.view, 'abc123def456');
    assert.equal(logged.reason, 'pagehide');
    assert.equal(logged.failure, 'connect');
    assert.equal(logged.host, 'Claude');
    assert.equal(logged.origin, 'sandbox.host.example');
    assert.equal(logged.clientAuthored, true, 'a report is marked as untrusted client input');
    assert.equal(logged.level, 'debug');
    assert.deepEqual(logged.marks, {script: 12, main: 411, fonts: 1300, context: 980});
    assert.deepEqual(logged.errors, [{type: 'csp', directive: 'connect-src', blocked: 'https'}, {type: 'error', name: 'TypeError'}]);
    assert.ok(!JSON.stringify(logs).includes(ANSWER), 'free text in a report is never logged');

    for (const bad of ['not json', JSON.stringify({...report, v: 2}), JSON.stringify({...report, id: 'has space'}), JSON.stringify({...report, reason: 'other'})]) {
      assert.equal((await beacon(bad)).status, 400, bad);
    }
    assert.equal((await beacon('x'.repeat(9000))).status, 413);
    assert.equal((await beacon(streamOf(9000) as unknown as string, {})).status, 413, 'the size bound holds without a Content-Length');
    assert.equal(logs.filter(r => r.event === 'view.report.invalid').length, 6);
    assert.ok(logs.filter(r => r.event === 'view.report.invalid').every(r => r.level === 'warn'));
  } finally { await app.close(); }
});

test('request inspection is bounded by bytes read, not by the declared length, and never blocks the exchange', async () => {
  const {app, logs} = harness(MEASURING);
  try {
    const response = await app.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: {host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream'},
      body: streamOf(2 * MAX_INSPECTED_BODY), duplex: 'half',
    } as RequestInit));
    await response.text();
    for (let waited = 0; !logs.some(r => r.event === 'mcp.response') && waited < 1000; waited += 10) await new Promise(r => setTimeout(r, 10));
    assert.equal(logs.find(r => r.event === 'mcp.rpc')?.rpc, 'oversize');
    assert.equal(logs.find(r => r.event === 'mcp.response')?.rpc, 'oversize', 'the handler still answered the request');
  } finally { await app.close(); }
});

test('beacon reports are limited per minute and the limit is noted once', async () => {
  const {app, logs, beacon} = harness({MCP_VIEW_DIAGNOSTICS_ORIGIN: ORIGIN});
  try {
    const body = JSON.stringify({v: 1, id: 'abc123def456', release: 'r1', reason: 'load', marks: {script: 1}});
    const statuses: number[] = [];
    for (let i = 0; i < VIEW_REPORTS_PER_MINUTE + 3; i++) statuses.push((await beacon(body)).status);
    assert.equal(statuses.filter(status => status === 204).length, VIEW_REPORTS_PER_MINUTE);
    assert.deepEqual(statuses.slice(VIEW_REPORTS_PER_MINUTE), [429, 429, 429]);
    assert.equal(logs.filter(r => r.event === 'view.report.limited').length, 1);
    assert.equal(logs.find(r => r.event === 'view.prepared')?.diagnostics, true);
    assert.equal(logs.find(r => r.event === 'view.prepared')?.connectDomains, ORIGIN);
  } finally { await app.close(); }
});

test('a bounded read stops pulling once the limit is passed', async () => {
  let pulled = 0;
  const source = new ReadableStream<Uint8Array>({pull(controller) {
    const chunk = new Uint8Array(4096);
    pulled += chunk.byteLength;
    controller.enqueue(chunk);
  }}, {highWaterMark: 0});
  const read = await readBounded(source, MAX_INSPECTED_BODY);
  assert.ok('exceeded' in read);
  assert.ok(pulled <= MAX_INSPECTED_BODY + 4096, `pulled ${pulled} bytes from an endless stream`);
});
