import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TOOL_UNAVAILABLE_TEXT} from '../src/server/create-server.js';
import {BRANDING} from '../src/view/branding.js';
import {readAnswerEnvelope} from '../src/view/envelope.js';
import {classifyCardResult, UNSUPPORTED_RESULT_TEXT} from '../src/view/tool-result.js';

// What the definition's one reader makes of a result that carries only this structured content.
const readCardContent = (structuredContent: unknown) => {
  const outcome = classifyCardResult({structuredContent});
  return outcome.kind === 'content' ? outcome.content : undefined;
};

test('structured results require the current envelope, without legacy acceptance', () => {
  for (const version of [undefined, '0.0.1', '9.9.9']) {
    assert.equal(readCardContent({version, question: 'q', answer: 'a'}), undefined);
    assert.deepEqual(classifyCardResult({structuredContent: {version, question: 'q', answer: 'a'}}), {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT});
  }
  assert.deepEqual(readCardContent({version: '0.1.0', question: 'q', answer: 'complete answer\n'}), {heading: 'q', markdown: 'complete answer\n'});
  assert.deepEqual(readAnswerEnvelope({version: '0.1.0', question: '', answer: 'a'}), {question: '', answer: 'a'});
});

test('anything that is not the envelope is unsupported, and nothing is repaired', () => {
  for (const value of [undefined, null, 'text', 3, [], {}, {version: '0.1.0', question: 'q'}, {version: '0.1.0', question: 'q', answer: ''}, {version: '0.1.0', question: 1, answer: 'a'}, {version: '0.1.0', answer: 'a'}]) {
    assert.equal(readCardContent(value), undefined, JSON.stringify(value));
  }
});

test('the card is shown the answer bytes exactly as sent', () => {
  const answer = ' leading and trailing space \n\n3. numbered\n\nالإجابة\n';
  assert.equal(readCardContent({version: '0.1.0', question: 'q', answer})?.markdown, answer);
});

test('the one problem sentence is the tool\'s own safe failure text', () => {
  assert.equal(BRANDING.problemText, TOOL_UNAVAILABLE_TEXT);
});
