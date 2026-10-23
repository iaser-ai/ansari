import assert from 'node:assert/strict';
import {createAnsariMcpServer} from '../../src/server/create-server.ts';

// Each factory call builds its own server and request lifetime. Whatever way a server ends, its request
// timer must be released, or this process stays alive until the 60 s request budget: the parent test
// gives it a few seconds to exit on its own.
const make = () => createAnsariMcpServer({
  completer: {async complete() { throw new Error('not a tool call'); }},
  view: {uri: 'ui://views/answer-card.00000000000000000000000000000000.html', title: 'synthetic', html: '<html></html>', csp: {connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: []}},
  logger: () => {},
});
type Closing = {start(): Promise<void>; send(): Promise<void>; close(): Promise<void>; onclose?: () => void};
const transport = (closeError?: Error): Closing => {
  const t: Closing = {async start() {}, async send() {}, async close() { t.onclose?.(); if (closeError) throw closeError; }};
  return t;
};

// 1. Disposed before any transport was connected, then closed again: the repeated close is harmless.
const unconnected = make();
await unconnected.close();
await unconnected.close();

// 2. Connected, then closed through its transport and again through the server.
const connected = make();
await connected.connect(transport() as never);
await connected.close();
await connected.close();

// 3. Closing fails: the lifetime still ends and the failure is the caller's to see.
const failing = make();
await failing.connect(transport(new Error('transport close failed')) as never);
await assert.rejects(failing.close(), /transport close failed/);

console.log('servers closed');
