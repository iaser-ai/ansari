import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFetchApp} from '../src/server/fetch-app.ts';
import {VIEW_MAJOR} from '../src/server/view-artifact.ts';
import {ANSWER_ENVELOPE_VERSION} from '../src/view/envelope.ts';

// The card's address names its compatibility line (`ui://views/answer-card.v<VIEW_MAJOR>.html`), not its bytes, so a host
// that already loaded the card keeps reading new results with it. A result an already-loaded card cannot read must therefore
// move the address. This records the result contract each major's card reads: changing the envelope version or the tool's
// output schema fails here until VIEW_MAJOR goes up and the new contract is recorded under it, in the same commit.
const CONTRACTS: Record<number, {envelope: string; outputSchema: unknown}> = {
  1: {
    envelope: '0.1.0',
    outputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {version: {type: 'string', const: '0.1.0'}, question: {type: 'string'}, answer: {type: 'string'}},
      required: ['version', 'question', 'answer'],
      additionalProperties: false,
    },
  },
};

/** The tool's output schema exactly as a host discovers it from `tools/list`. */
async function discoveredOutputSchema(): Promise<unknown> {
  const app = createFetchApp({
    release: 'contract', allowedHosts: ['localhost'], allowedOrigins: ['localhost'], enableJsonResponse: true,
    html: '<html><head></head><body>contract</body></html>', logger: () => {}, completer: {async complete() { return 'unused'; }},
  });
  try {
    const response = await app.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    }));
    const text = await response.text();
    const message = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: '))!.slice('data: '.length));
    const tools = message.result.tools as Array<{name: string; outputSchema?: unknown}>;
    return tools.find(tool => tool.name === 'answer_islamic_question')?.outputSchema;
  } finally {
    await app.close();
  }
}

test('the result contract the card reads is recorded for its compatibility line', async () => {
  const recorded = CONTRACTS[VIEW_MAJOR];
  assert.ok(recorded, `record the result contract that the v${VIEW_MAJOR} card reads in CONTRACTS`);
  const changed = `The card's result contract changed while VIEW_MAJOR stayed ${VIEW_MAJOR}: a card already loaded at v${VIEW_MAJOR} would misread the new result. Increase VIEW_MAJOR and record the new contract under it.`;
  assert.equal(ANSWER_ENVELOPE_VERSION, recorded.envelope, changed);
  assert.deepEqual(await discoveredOutputSchema(), recorded.outputSchema, changed);
});
