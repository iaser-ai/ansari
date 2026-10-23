import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// The credit follows the card's own link rules through the stack's `useHostLink`, which needs a card
// view the stack alone builds. The stack exposes no way to make one outside a running application, so
// the policy-dependent behavior is asserted where the real stack runs it: test/browser.ts ("links:" checks)
// opens the credit as a button under the Standard policy, keeps it inert text under Strict, and has the
// host open it. What a Node render can state without a view is asserted here.
// The stack's card entry registers browser custom elements when it is loaded, so this test supplies the
// globals that import reads (HTMLElement, customElements) and nothing else.
Object.assign(globalThis, {HTMLElement: class {}, customElements: {define() {}, get: () => undefined}});
const {SagaCredit} = await import('../src/view/saga-credit.js');

test('branding can omit the credit', () => {
  assert.equal(renderToStaticMarkup(createElement(SagaCredit, {enabled: false})), '');
});

test('outside a card view the credit link stays inert text', () => {
  const shown = renderToStaticMarkup(createElement(SagaCredit, {enabled: true}));
  assert.match(shown, /Built with/);
  assert.match(shown, /saga a2ui/);
  assert.equal(shown.includes('<button'), false);
});
