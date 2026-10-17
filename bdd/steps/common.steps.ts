import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { ask, createThread, latestAnswerRecord, signUp } from '../support/api.ts';
import { requireSettings } from '../support/env.ts';
import { fakeGemini } from '../support/fake-gemini.ts';
import { numberedImage, randomNumbers, toInput } from '../support/images.ts';
import { profileFor, startServer } from '../support/servers.ts';
import type { ImageWorld } from '../support/world.ts';

Given(/^the API is running with (.+)$/, async function (this: ImageWorld, setup: string) {
  this.profile = profileFor(setup);
  if (setup.includes('empty answer')) {
    // The point of this setup is Inkling taking over, so it needs the real Inkling.
    requireSettings(['TINKER_API_KEY'], 'Inkling taking over from an empty Gemini answer');
    fakeGemini.mode = 'empty';
  }
  this.baseUrl = await startServer(this.profile);
});

Given('I am signed in as a registered user', async function (this: ImageWorld) {
  this.account = await signUp(this.baseUrl, 'registered');
  this.threadId = await createThread(this.baseUrl, this.account.token);
});

Given('I am signed in as a guest', async function (this: ImageWorld) {
  this.account = await signUp(this.baseUrl, 'guest');
  this.threadId = await createThread(this.baseUrl, this.account.token);
});

When('I ask {string} with no images', async function (this: ImageWorld, question: string) {
  this.numbers = [];
  this.last = await ask(this.baseUrl, this.token, this.threadId, question, []);
  this.lastStatus = this.last.status;
});

When(/^I ask "(.*)" with (\d+) numbered images?$/, async function (this: ImageWorld, question: string, count: string) {
  this.numbers = randomNumbers(Number(count));
  const images = await Promise.all(this.numbers.map(async (n) => toInput(await numberedImage(n))));
  this.last = await ask(this.baseUrl, this.token, this.threadId, question, images);
  this.lastStatus = this.last.status;
});

Then('I get an answer', function (this: ImageWorld) {
  const r = this.last;
  assert.ok(r, 'no question was asked');
  // Cucumber's formatter hides a message that starts with "expected"; say it another way.
  assert.ok(r.status === 200, `no answer: status ${r.status}: ${r.error}`);
  assert.equal(r.error, null, `the answer failed: ${r.error}`);
  assert.ok(r.text.trim().length > 0, 'the answer was empty');
});

Then('the answer contains the number from every image', function (this: ImageWorld) {
  const text = this.last?.text ?? '';
  // Models sometimes group digits ("12,345" or "12 345").
  const digitsOnly = text.replace(/(?<=\d)[,\s.٬](?=\d)/g, '');
  const missing = this.numbers.filter((n) => !digitsOnly.includes(n));
  assert.deepEqual(missing, [], `the answer does not name ${missing.join(', ')}; it said: ${text.slice(0, 300)}`);
});

Then('the answer was written by Inkling', async function (this: ImageWorld) {
  const record = await latestAnswerRecord(this.threadId);
  assert.ok(record, 'no answer was recorded for the thread');
  assert.equal(record.modelProvider, 'inkling', `the answer was written by ${record.modelProvider} (${record.modelId})`);
});

Then('the response status is {int}', function (this: ImageWorld, expected: number) {
  const actual = this.raw ? this.raw.status : this.lastStatus;
  const why = this.last?.error ? `: ${this.last.error}` : '';
  assert.ok(actual === expected, `status was ${actual}, not ${expected}${why}`);
});
