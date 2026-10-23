import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import type {AnswerCompleter} from '../src/server/ansari-client.ts';
import {listen} from '../src/node/http-server.ts';
import {TOOL_UNAVAILABLE_TEXT} from '../src/server/create-server.ts';

// The tool declares a 60 s handler wait. The SDK's default 10 s request budget must not clamp it, and a call
// that outlasts the declared budget must still end with the safe failure, bounded, on a server that keeps serving.

const html = '<!doctype html><html><head><title>synthetic resource</title></head><body>synthetic</body></html>';
const SDK_DEFAULT_REQUEST_MS = 10_000;

type Call = {isError?: boolean; content: unknown; structuredContent?: unknown};

async function callOnce(
  requestMs: number | undefined,
  completer: AnswerCompleter,
  json: boolean,
  questions: readonly string[],
): Promise<{calls: {call: Call; elapsedMs: number}[]}> {
  const service = await listen({port: 0, host: '127.0.0.1', enableJsonResponse: json, html, requestMs, completer, logger: () => {}});
  const client = new Client({name: 'budget-test', version: '0'});
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`));
  try {
    await client.connect(transport);
    const calls: {call: Call; elapsedMs: number}[] = [];
    // Several independent HTTP calls: each receives a fresh request budget.
    for (const question of questions) {
      const started = performance.now();
      const call = await client.callTool({name: 'ask_ansari', arguments: {question}}, {timeout: 120_000}) as Call;
      calls.push({call, elapsedMs: performance.now() - started});
    }
    return {calls};
  } finally {
     await client.close(); await service.close();
  }
}

for (const json of [false, true]) test(`an answer after the SDK default request budget and within the declared bound succeeds over ${json ? 'JSON' : 'SSE'}`, async () => {
  const delayMs = SDK_DEFAULT_REQUEST_MS + 500;
  const completer: AnswerCompleter = {async complete({question}) { await new Promise(resolve => setTimeout(resolve, delayMs)); return `Synthetic answer to ${question}`; }};
  const {calls: [{call, elapsedMs}]} = await callOnce(undefined, completer, json, ['slow synthetic question']);
  assert.ok(elapsedMs > SDK_DEFAULT_REQUEST_MS, `the call took ${elapsedMs} ms, not past the default budget`);
  assert.equal(call.isError, undefined);
  assert.deepEqual(call.content, [{type: 'text', text: 'Synthetic answer to slow synthetic question'}]);
  assert.deepEqual(call.structuredContent, {version: '0.1.0', question: 'slow synthetic question', answer: 'Synthetic answer to slow synthetic question'});
});

for (const json of [false, true]) test(`a call that outlasts the request budget still fails safely and bounded, and the next call gets its own budget over ${json ? 'JSON' : 'SSE'}`, async () => {
  const requestMs = 400;
  let started = 0;
  const completer: AnswerCompleter = {async complete({question}) {
    started += 1;
    await new Promise(resolve => setTimeout(resolve, question === 'late' ? requestMs * 5 : requestMs / 4));
    return `Synthetic answer to ${question}`;
  }};
  const {calls} = await callOnce(requestMs, completer, json, ['late', 'prompt', 'prompt again']);
  const [late, first, second] = calls;
  assert.equal(late.call.isError, true);
  assert.deepEqual(late.call.content, [{type: 'text', text: TOOL_UNAVAILABLE_TEXT}]);
  assert.equal(late.call.structuredContent, undefined);
  assert.ok(late.elapsedMs >= requestMs * 0.9 && late.elapsedMs < requestMs * 4, `the failure arrived after ${late.elapsedMs} ms`);
  // A spent budget is not carried into later calls from the same client, and each later call gets a fresh one.
  for (const {call} of [first, second]) {
    assert.equal(call.isError, undefined);
    assert.equal((call.structuredContent as {version: string}).version, '0.1.0');
  }
  assert.equal(started, 3);
});
