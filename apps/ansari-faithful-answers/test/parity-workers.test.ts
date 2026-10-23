import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {defineParityCases} from './parity-cases.ts';
import {answerFor, startRuntime, startUpstream} from './runtime-harness.ts';

// The Workers bundle (dist-worker/index.js) in the local Workers runtime: the same cases as Node.
describe('Workers runtime', () => defineParityCases('workers'));

// Workers has no process signals: its cleanup is per request. A caller that disconnects mid-call must leave the
// isolate serving, and ending the runtime itself is the host's stop, not a signal the application handles.
describe('Workers lifecycle', () => {
  it('keeps serving after a caller abandons an in-flight call, and stops when the runtime stops', async () => {
    const upstream = await startUpstream();
    const runtime = await startRuntime('workers', {json: false, upstream: upstream.url});
    try {
      const started = upstream.seen.length;
      const controller = new AbortController();
      const abandoned = fetch(`${runtime.origin}/mcp`, {
        method: 'POST', signal: controller.signal,
        headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'ask_ansari'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'ask_ansari', arguments: {question: 'hang'}, _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': {name: 'abandon', version: '1'}, 'io.modelcontextprotocol/clientCapabilities': {},
        }}}),
      }).then(response => response.text()).catch(() => undefined);
      for (let waited = 0; upstream.seen.length === started; waited += 50) {
        assert.ok(waited < 10_000, 'the Worker called the upstream');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      controller.abort();
      await abandoned;
      // A later request is served normally, and its own work is unaffected by the abandoned one.
      assert.equal((await fetch(`${runtime.origin}/health`)).status, 200);
      const reply = await fetch(`${runtime.origin}/mcp`, {
        method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'ask_ansari', arguments: {question: 'after abandon'}}}),
      });
      assert.equal(reply.status, 200);
      assert.match(await reply.text(), new RegExp(answerFor('after abandon').split('\n')[0]!));
      assert.ok(runtime.alive());
    } finally {
      const {remaining} = await runtime.close();
      await upstream.close();
      assert.equal(remaining, false, 'no Wrangler or workerd process outlives the stop');
    }
  });
});
