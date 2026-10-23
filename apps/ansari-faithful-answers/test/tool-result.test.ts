import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyCardResult, classifyToolResult, UNSUPPORTED_RESULT_TEXT} from '../src/view/tool-result.js';
test('structured results require the current envelope, without legacy acceptance',()=>{
  for(const version of [undefined,'0.0.1','9.9.9']) assert.equal(classifyToolResult({structuredContent:{version,question:'q',answer:'a'}}).kind,'rejected');
  assert.deepEqual(classifyToolResult({structuredContent:{version:'0.1.0',question:'q',answer:'complete answer\n'}}),{kind:'valid',envelope:{question:'q',answer:'complete answer\n'}});
});
test('hosts that deliver only the current text result preserve its bytes',()=>{
  assert.deepEqual(classifyToolResult({content:[{type:'text',text:'answer\n'}]}),{kind:'valid',envelope:{question:'',answer:'answer\n'}});
});
// The classifier's added coverage: behavior the original assertions did not state, none of them weakened.
test('a structured envelope that is present but malformed is unsupported even when text exists', () => {
  const text = [{type: 'text', text: 'fallback'}];
  for (const structuredContent of [['x'], 'x', 3, {}, {version: '0.1.0', question: 'q'}, {version: '0.1.0', answer: 'a'}, {version: '0.1.0', question: 'q', answer: ''}, {version: '9.9.9', question: 'q', answer: 'a'}]) {
    assert.deepEqual(classifyToolResult({content: text, structuredContent}), {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT}, JSON.stringify(structuredContent));
  }
});
test('absent or null structured content falls back to the first text block, exactly as sent', () => {
  for (const structuredContent of [undefined, null]) assert.deepEqual(classifyToolResult({structuredContent, content: [{type: 'text', text: ' a\n\n  b\n'}]}), {kind: 'valid', envelope: {question: '', answer: ' a\n\n  b\n'}});
});
test('the first text block decides: an empty one is not skipped for a later one', () => {
  assert.deepEqual(classifyToolResult({content: [{type: 'text', text: ''}, {type: 'text', text: 'later'}]}), {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT});
  assert.deepEqual(classifyToolResult({content: [{type: 'image'}, {type: 'text', text: 'second block'}]}), {kind: 'valid', envelope: {question: '', answer: 'second block'}});
  assert.deepEqual(classifyToolResult({content: []}), {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT});
  assert.deepEqual(classifyToolResult({}), {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT});
});
test('a failed call is always a problem and shows its first text, else the unsupported sentence, even with valid structured content', () => {
  const valid = {version: '0.1.0', question: 'q', answer: 'a'};
  assert.deepEqual(classifyToolResult({isError: true, content: [{type: 'text', text: 'Server wrote this.'}]}), {kind: 'rejected', text: 'Server wrote this.'});
  assert.deepEqual(classifyToolResult({isError: true, structuredContent: valid, content: [{type: 'text', text: 'Server wrote this.'}]}), {kind: 'rejected', text: 'Server wrote this.'});
  assert.deepEqual(classifyToolResult({isError: true, structuredContent: valid}), {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT});
  assert.deepEqual(classifyToolResult({isError: true, content: [{type: 'text', text: ''}, {type: 'text', text: 'later'}]}), {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT});
});
test('the card outcome carries the answer bytes as Markdown and the question as the heading', () => {
  assert.deepEqual(classifyCardResult({structuredContent: {version: '0.1.0', question: 'q', answer: ' keep \n'}}), {kind: 'content', content: {heading: 'q', markdown: ' keep \n'}});
  assert.deepEqual(classifyCardResult({content: [{type: 'text', text: 'answer\n'}]}), {kind: 'content', content: {heading: '', markdown: 'answer\n'}});
  assert.deepEqual(classifyCardResult({isError: true, content: [{type: 'text', text: 'Server wrote this.'}]}), {kind: 'rejected', text: 'Server wrote this.'});
});
