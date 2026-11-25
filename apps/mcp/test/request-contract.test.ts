import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {listen} from '../src/node/http-server.ts';
import {createAnsariHttpCompleter} from '../src/server/ansari-client.ts';
import {createFetchApp} from '../src/server/fetch-app.ts';
import {settingsFromEnv} from '../src/server/runtime-config.ts';

const toolName = 'answer_islamic_question';
const html = '<html><body>synthetic contract</body></html>';
const legacyDescription = 'Answers questions about Islam including theology, jurisprudence (fiqh), history, Quranic interpretation (tafsir), Hadith sciences, Islamic law, worship practices, ethics, spirituality, and contemporary issues. Provides comprehensive answers with citations from Quran, authentic Hadith, and classical Islamic scholarship. Can handle questions about specific verses, hadiths, scholarly opinions, historical events, prophets, companions, and modern applications of Islamic principles.';

test('legacy discovery and question bounds are enforced before upstream work', async () => {
  const questions: string[] = [];
  const service = await listen({host: '127.0.0.1', port: 0, html, logger: () => {}, completer: {
    async complete({question}) { questions.push(question); return `Answer to ${question}`; },
  }});
  const client = new Client({name: 'contract', version: '1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`)));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), [toolName]);
    assert.equal(tools[0].description, legacyDescription);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    assert.equal(tools[0].annotations?.openWorldHint, true);
    assert.equal(tools[0].annotations?.destructiveHint, false);
    assert.equal(tools[0].annotations?.idempotentHint, undefined);
    for (const question of ['', 'x'.repeat(4001)]) {
      const result = await client.callTool({name: toolName, arguments: {question}}).then(
        value => ({value}), error => ({error}),
      );
      if ('value' in result) assert.equal(result.value.isError, true);
      else assert.ok(result.error instanceof Error);
      assert.equal(questions.length, 0, 'invalid input never reaches the completer');
    }
    for (const question of ['x', 'x'.repeat(4000)]) {
      const result = await client.callTool({name: toolName, arguments: {question}});
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.content, [{type: 'text', text: `Answer to ${question}`}]);
    }
    assert.deepEqual(questions.map(question => question.length), [1, 4000]);
  } finally { await client.close(); await service.close(); }
});

test('configured allowlists replace local defaults, including an explicitly empty list', () => {
  const local = settingsFromEnv({});
  assert.deepEqual(local.allowedHosts, ['localhost', '127.0.0.1']);
  assert.deepEqual(local.allowedOrigins, local.allowedHosts);
  const configured = settingsFromEnv({MCP_ALLOWED_HOSTS: ' app.example, app.example, ', MCP_ALLOWED_ORIGINS: ' chat.example '});
  assert.deepEqual(configured.allowedHosts, ['app.example']);
  assert.deepEqual(configured.allowedOrigins, ['chat.example']);
  for (const blank of ['', ' , ']) {
    const empty = settingsFromEnv({MCP_ALLOWED_HOSTS: blank, MCP_ALLOWED_ORIGINS: blank});
    assert.deepEqual(empty.allowedHosts, []);
    assert.deepEqual(empty.allowedOrigins, []);
  }
  const explicit = settingsFromEnv({MCP_ALLOWED_HOSTS: 'env.example', MCP_ALLOWED_ORIGINS: 'env.example'}, {
    allowedHosts: ['override.example', 'override.example'], allowedOrigins: [],
  });
  assert.deepEqual(explicit.allowedHosts, ['override.example']);
  assert.deepEqual(explicit.allowedOrigins, []);
});

test('the real middleware refuses localhost when a deployment allowlist replaces it', async () => {
  const settings = settingsFromEnv({MCP_ALLOWED_HOSTS: 'app.example', MCP_ALLOWED_ORIGINS: 'chat.example'});
  const app = createFetchApp({...settings, html, logger: () => {}, completer: {async complete() { return 'synthetic'; }}});
  const request = (host: string, origin?: string) => app.fetch(new Request('http://app.example/mcp', {
    method: 'GET', headers: {host, ...(origin ? {origin} : {})},
  }));
  try {
    assert.equal((await request('localhost')).status, 403);
    assert.equal((await request('app.example', 'http://localhost')).status, 403);
    assert.equal((await request('app.example', 'https://chat.example')).status, 405);
    assert.equal((await request('app.example')).status, 405, 'a non-browser client needs no Origin header');
  } finally { await app.close(); }
});

for (const json of [false, true]) for (const stall of ['headers', 'body']) {
  test(`${json ? 'JSON' : 'SSE'} timeout aborts upstream ${stall} consumption and a later call succeeds`, async () => {
    const disconnected: string[] = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const question = JSON.parse(body).messages[0].content as string;
        if (question === 'next') { res.end('complete synthetic answer'); return; }
        res.once('close', () => { if (!res.writableEnded) disconnected.push(question); });
        if (stall === 'body') { res.writeHead(200, {'content-type': 'text/plain'}); res.write('partial'); }
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as {port: number}).port;
    const service = await listen({host: '127.0.0.1', port: 0, html, enableJsonResponse: json, requestMs: 150,
      logger: () => {}, completer: createAnsariHttpCompleter({baseUrl: `http://127.0.0.1:${port}`}),
    });
    const client = new Client({name: 'fetch-budget', version: '1'});
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`)));
      const timedOut = await client.callTool({name: toolName, arguments: {question: stall}});
      assert.equal(timedOut.isError, true);
      assert.deepEqual(timedOut.content, [{type: 'text', text: 'Ansari could not complete this request.'}]);
      for (let waited = 0; disconnected.length === 0 && waited < 500; waited += 20) await delay(20);
      assert.deepEqual(disconnected, [stall], 'timeout closes the actual outstanding fetch');
      const next = await client.callTool({name: toolName, arguments: {question: 'next'}});
      assert.equal(next.isError, undefined);
      assert.deepEqual(next.content, [{type: 'text', text: 'complete synthetic answer'}]);
    } finally {
      await client.close(); await service.close();
      const stopped = new Promise<void>(resolve => upstream.close(() => resolve()));
      upstream.closeAllConnections(); await stopped;
    }
  });
}
