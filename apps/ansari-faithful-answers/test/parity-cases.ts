import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {after, before, describe, it} from 'node:test';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY} from '@modelcontextprotocol/server';
import {TOOL_UNAVAILABLE_TEXT} from '../src/server/create-server.ts';
import {stampHtmlRevision} from '../src/server/operation-log.ts';
import {
  PRIVATE_CANARY, RELEASE, TRUSTED_ORIGIN, UPSTREAM_AUTHORIZATION, answerFor, startRuntime, startUpstream,
  type Runtime, type RuntimeKind,
} from './runtime-harness.ts';

type Call = {isError?: boolean; content: unknown; structuredContent?: unknown; _meta?: {ui?: {resourceUri?: string}}};

const builtCard = readFileSync(new URL('../dist/view.html', import.meta.url), 'utf8');
const MODERN = '2026-07-28';

function rpcBody(id: number, method: string, params: Record<string, unknown>, modern: boolean, progressToken?: string) {
  const meta = {
    ...(progressToken ? {progressToken} : {}),
    ...(modern ? {[PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_INFO_META_KEY]: {name: 'parity', version: '1'}, [CLIENT_CAPABILITIES_META_KEY]: {}} : {}),
  };
  return JSON.stringify({jsonrpc: '2.0', id, method, params: Object.keys(meta).length ? {...params, _meta: meta} : params});
}

function post(origin: string, method: string, params: Record<string, unknown>, options: {modern?: boolean; headers?: Record<string, string>; progressToken?: string; id?: number} = {}) {
  const modern = options.modern ?? false;
  return fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(modern ? {'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...('name' in params ? {'Mcp-Name': String(params.name)} : {})} : {}),
      ...options.headers,
    },
    body: rpcBody(options.id ?? 1, method, params, modern, options.progressToken),
  });
}

async function messages(response: Response): Promise<any[]> {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return [JSON.parse(text)];
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
const terminal = async (response: Response, id = 1) => {
  const found = (await messages(response)).find(message => message.id === id);
  assert.ok(found, 'expected a terminal RPC response');
  return found;
};

async function withClient<T>(origin: string, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({name: 'parity', version: '1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  try { return await use(client); } finally { await client.close(); }
}
const ask = (client: Client, question: string) => client.callTool({name: 'ask_ansari', arguments: {question}}, {timeout: 120_000}) as Promise<Call>;

/**
 * The HTTP/MCP behaviour both hosting targets must share. Each case runs against the built artifact of one runtime,
 * with one SSE and one JSON-response instance, a real upstream and no application-level mock.
 */
export function defineParityCases(kind: RuntimeKind): void {
  let upstream!: Awaited<ReturnType<typeof startUpstream>>;
  let sse!: Runtime;
  let json!: Runtime;
  before(async () => {
    upstream = await startUpstream();
    const started = await Promise.allSettled([false, true].map(mode => startRuntime(kind, {json: mode, upstream: upstream.url})));
    const failed = started.find(result => result.status === 'rejected');
    if (failed) {
      // Never leave the instance that did start running.
      await Promise.all(started.map(result => result.status === 'fulfilled' ? result.value.close() : undefined));
      throw (failed as PromiseRejectedResult).reason;
    }
    [sse, json] = started.map(result => (result as PromiseFulfilledResult<Runtime>).value) as [Runtime, Runtime];
  });
  after(async () => { await Promise.all([sse?.close(), json?.close()]); await upstream?.close(); });

  for (const mode of ['sse', 'json'] as const) {
    const runtime = () => mode === 'sse' ? sse : json;

    describe(`${kind} ${mode}: health, complete answer and linked resource`, () => {
      it('reports health with the explicit release and serves nothing else', async () => {
        const health = await fetch(`${runtime().origin}/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), {ok: true, mcp: '/mcp', release: RELEASE});
        for (const path of ['/demo', '/demo/answer', '/fonts/amiri.ttf']) assert.equal((await fetch(`${runtime().origin}${path}`)).status, 404);
      });

      it('returns the complete answer with attribution and the linked HTML resource with its identity', async () => {
        await withClient(runtime().origin, async client => {
          assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ask_ansari']);
          const before = upstream.seen.length;
          const question = `complete ${kind} ${mode}`;
          const result = await ask(client, question);
          const answer = answerFor(question);
          assert.equal(result.isError, undefined);
          assert.deepEqual(result.content, [{type: 'text', text: answer}]);
          assert.deepEqual(result.structuredContent, {version: '0.1.0', question, answer});
          assert.match(answer, /\*Answered by \[Ansari\]\(https:\/\/askansari\.ai\)\.\*/);
          // Explicit configuration reached the upstream call.
          const sent = upstream.seen.slice(before).find(request => request.question === question);
          assert.ok(sent, 'the upstream received the question');
          assert.equal(sent.headers.authorization, UPSTREAM_AUTHORIZATION);
          assert.equal(sent.headers['x-ansari-client'], 'parity-test');

          const uri = result._meta?.ui?.resourceUri;
          assert.ok(uri);
          assert.deepEqual((await client.listResources()).resources.map(resource => resource.uri), [uri]);
          const text = ((await client.readResource({uri})).contents[0] as {text: string}).text;
          // Release stamping precedes hashing: the served bytes are the built card with the release stamped, and the identity is theirs.
          assert.equal(text, stampHtmlRevision(builtCard, RELEASE));
          assert.equal(uri, `ui://views/answer-card.${createHash('sha256').update(text).digest('hex').slice(0, 32)}.html`);
          await assert.rejects(client.readResource({uri: 'ui://obsolete.html'}));
        });
      });
    });

    describe(`${kind} ${mode}: protocol paths and request isolation`, () => {
      for (const modern of [true, false]) it(`${modern ? '2026' : 'older-host'} discovery and concurrent calls need no session and do not mix`, async () => {
        const origin = runtime().origin;
        const listed = await post(origin, 'tools/list', {}, {modern});
        assert.equal(listed.status, 200);
        assert.equal(listed.headers.get('mcp-session-id'), null);
        assert.deepEqual((await terminal(listed)).result.tools.map((tool: {name: string}) => tool.name), ['ask_ansari']);
        const questions = ['isolated one', 'slow:300', 'FAIL', 'isolated two'];
        const replies = await Promise.all(questions.map(async question => {
          const response = await post(origin, 'tools/call', {name: 'ask_ansari', arguments: {question}}, {modern});
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('mcp-session-id'), null);
          return (await terminal(response)).result as Call;
        }));
        replies.forEach((reply, index) => {
          if (questions[index] === 'FAIL') {
            assert.equal(reply.isError, true);
            assert.deepEqual(reply.content, [{type: 'text', text: TOOL_UNAVAILABLE_TEXT}]);
          } else {
            assert.equal((reply.structuredContent as {answer: string}).answer, answerFor(questions[index]!));
          }
        });
        for (const method of ['GET', 'DELETE']) assert.equal((await fetch(`${origin}/mcp`, {method})).status, 405);
      });

      it('fails safely without leaking the upstream, then recovers on the same runtime', async () => {
        await withClient(runtime().origin, async client => {
          const failed = await ask(client, 'FAIL');
          assert.equal(failed.isError, true);
          assert.deepEqual(failed.content, [{type: 'text', text: TOOL_UNAVAILABLE_TEXT}]);
          assert.equal(failed.structuredContent, undefined);
          assert.ok(!JSON.stringify(failed).includes(PRIVATE_CANARY));
          const recovered = await ask(client, 'after failure');
          assert.equal(recovered.isError, undefined);
          assert.equal((recovered.structuredContent as {answer: string}).answer, answerFor('after failure'));
        });
        const logs = runtime().logs.join('\n');
        assert.match(logs, /"event":"source\.error"/);
        assert.ok(!logs.includes(PRIVATE_CANARY), 'logs record no upstream content');
        assert.ok(!logs.includes('after failure'), 'logs record no question');
      });
    });

    describe(`${kind} ${mode}: Host and Origin checks, body bounds and requested progress`, () => {
      it('rejects an untrusted Host or Origin and a malformed body before calling Ansari, and accepts a configured Origin', async () => {
        const origin = runtime().origin;
        const before = upstream.seen.length;
        const params = {name: 'ask_ansari', arguments: {question: 'guarded'}};
        const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
          const req = httpRequest(`${origin}/mcp`, {method: 'POST', headers: {host: 'other.example'}}, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', reject); req.end();
        });
        assert.equal(hostStatus, 403);
        assert.equal((await post(origin, 'tools/call', params, {headers: {origin: 'https://other.example'}})).status, 403);
        const malformed = await fetch(`${origin}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body: '{'});
        assert.equal(malformed.status, 400);
        assert.equal(upstream.seen.length, before, 'no rejected request reached Ansari');
        for (const trusted of [TRUSTED_ORIGIN, 'http://localhost:1234']) {
          const accepted = await post(origin, 'tools/call', params, {headers: {origin: trusted}});
          assert.equal(accepted.status, 200, trusted);
          assert.equal((await terminal(accepted)).result.structuredContent.answer, answerFor('guarded'));
        }
      });

      for (const modern of [true, false]) it(`${modern ? 'modern' : 'older-host'} refuses a body over the SDK limit before calling Ansari`, async () => {
        const before = upstream.seen.length;
        const response = await post(runtime().origin, 'tools/call', {name: 'ask_ansari', arguments: {question: 'x'.repeat(4 * 1024 * 1024)}}, {modern});
        assert.equal(response.status, 413);
        assert.match(await response.text(), /Payload Too Large/);
        assert.equal(upstream.seen.length, before);
      });

      it('delivers the answer, and sends progress only when requested and only over SSE', async () => {
        const origin = runtime().origin;
        const params = {name: 'ask_ansari', arguments: {question: 'progress'}};
        const plain = await messages(await post(origin, 'tools/call', params, {modern: true}));
        assert.ok(!JSON.stringify(plain).includes('notifications/progress'), 'no progress unless requested');
        const response = await post(origin, 'tools/call', params, {modern: true, progressToken: 'progress-test', id: 2});
        assert.equal(response.status, 200);
        const received = await messages(response);
        assert.equal(received.find(message => message.id === 2)?.result.structuredContent.answer, answerFor('progress'));
        const progress = received.find(message => message.method === 'notifications/progress');
        if (mode === 'sse') assert.deepEqual(progress?.params, {progressToken: 'progress-test', progress: 0, total: 1});
        else assert.equal(progress, undefined);
      });
    });
  }

  describe(`${kind}: the 60-second handler budget`, () => {
    it('keeps an answer that arrives after the SDK default 10 s request budget, over SSE and JSON', async () => {
      const delayMs = 10_500;
      await Promise.all([sse, json].map(runtime => withClient(runtime.origin, async client => {
        const started = performance.now();
        const call = await ask(client, `slow:${delayMs}`);
        assert.ok(performance.now() - started > 10_000, 'the call outlasted the SDK default budget');
        assert.equal(call.isError, undefined);
        assert.equal((call.structuredContent as {answer: string}).answer, answerFor(`slow:${delayMs}`));
      })));
    });

    it('ends a call that outlasts 60 s with the safe failure, and the next call gets its own budget', async () => {
      await withClient(sse.origin, async client => {
        const started = performance.now();
        const call = await ask(client, 'hang');
        const elapsed = performance.now() - started;
        assert.equal(call.isError, true);
        assert.deepEqual(call.content, [{type: 'text', text: TOOL_UNAVAILABLE_TEXT}]);
        assert.ok(elapsed >= 58_000 && elapsed < 80_000, `the failure arrived after ${Math.round(elapsed)} ms`);
        const next = await ask(client, 'fresh budget');
        assert.equal(next.isError, undefined);
      });
    });
  });
}
