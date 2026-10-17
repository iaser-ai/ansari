import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { ask, sendChatBody, sendRawBody, type ChatResult } from '../support/api.ts';
import { fakeGemini } from '../support/fake-gemini.ts';
import { numberedImage, toInput } from '../support/images.ts';
import type { ImageWorld } from '../support/world.ts';

const MB = 1024 * 1024;

const answered = (r: ChatResult) => r.status === 200 && r.error === null && r.text.trim().length > 0;

Given('the fake Gemini takes {int} seconds to answer', function (seconds: number) {
  fakeGemini.delayMs = seconds * 1000;
});

When('someone who is not signed in sends a {int} MB image question', async function (this: ImageWorld, size: number) {
  this.raw = await sendRawBody(this.baseUrl, `/api/v2/threads/${randomUUID()}/chat`, null, size * MB, true);
});

When('I send a {int} MB image question that declares its size', async function (this: ImageWorld, size: number) {
  this.raw = await sendRawBody(this.baseUrl, `/api/v2/threads/${this.threadId}/chat`, this.token, size * MB, true);
});

When(
  'I stream a {int} MB image question without declaring its size',
  async function (this: ImageWorld, size: number) {
    this.raw = await sendRawBody(this.baseUrl, `/api/v2/threads/${this.threadId}/chat`, this.token, size * MB, false);
  }
);

Then('the server refuses it before receiving {int} MB', function (this: ImageWorld, limit: number) {
  const r = this.raw;
  assert.ok(r, 'nothing was sent');
  const sentMb = (r.bytesSentWhenAnswered / MB).toFixed(1);
  assert.ok(
    r.bytesSentWhenAnswered < limit * MB,
    `the server took ${sentMb} MB of a ${r.totalBytes / MB} MB body before answering (status ${r.status}); it should stop reading at the 16 MB limit`
  );
  assert.ok(r.status === null || r.status === 413, `no refusal: got ${r.status}, wanted 413 or a cut connection`);
});

When('I send an {string} image whose bytes are plain text', async function (this: ImageWorld, mediaType: string) {
  this.raw = null;
  this.lastStatus = await sendChatBody(this.baseUrl, this.token, this.threadId, {
    message: 'What is in this image?',
    images: [{ media_type: mediaType, data: Buffer.from('this is plain text, not an image').toString('base64') }],
  });
});

When('I send {int} image questions one after another', async function (this: ImageWorld, count: number) {
  const image = toInput(await numberedImage('12345'));
  this.batch = [];
  for (let i = 0; i < count; i++) {
    this.batch.push(await ask(this.baseUrl, this.token, this.threadId, 'What number is this?', [image]));
  }
});

When('I send {int} image questions at the same time', async function (this: ImageWorld, count: number) {
  const image = toInput(await numberedImage('12345'));
  this.batch = await Promise.all(
    Array.from({ length: count }, () => ask(this.baseUrl, this.token, this.threadId, 'What number is this?', [image]))
  );
});

Then('the first {int} are answered', function (this: ImageWorld, count: number) {
  const first = this.batch.slice(0, count);
  const failed = first.map((r, i) => ({ r, i })).filter(({ r }) => !answered(r));
  assert.deepEqual(
    failed.map(({ i, r }) => `#${i + 1}: ${r.status} ${r.error}`),
    [],
    'some of the questions within the limit were not answered'
  );
});

Then('the last one is refused with status {int}', function (this: ImageWorld, status: number) {
  const last = this.batch[this.batch.length - 1];
  assert.equal(
    last.status,
    status,
    `question #${this.batch.length} got status ${last.status}${answered(last) ? ' and was answered' : ''}; nothing limits how many image questions one user sends`
  );
});

Then('at most {int} are answered', function (this: ImageWorld, max: number) {
  const n = this.batch.filter(answered).length;
  assert.ok(n <= max, `${n} of ${this.batch.length} simultaneous image questions were answered; at most ${max} should be`);
});

Then('the rest are refused with status {int}', function (this: ImageWorld, status: number) {
  const others = this.batch.filter((r) => !answered(r));
  const wrong = others.filter((r) => r.status !== status).map((r) => `${r.status} ${r.error}`);
  assert.deepEqual(wrong, [], `refusals should all be ${status}`);
});
