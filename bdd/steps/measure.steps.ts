import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { ask, createThread, latestAnswerRecord, type AnswerRecord, type ImageInput } from '../support/api.ts';
import { requireSettings, settings } from '../support/env.ts';
import {
  APP_MAX_EDGE,
  FIXTURE_DIR,
  loadTextFixtures,
  numberedImage,
  randomNumbers,
  shrinkLikeTheApp,
  toInput,
} from '../support/images.ts';
import { addRow, fmt, median } from '../support/report.ts';
import type { ImageWorld } from '../support/world.ts';

/** Megabits per second for a few typical connections, for the upload estimate. */
const CONNECTIONS = [
  { name: 'slow 3G-like (1 Mbps up)', mbps: 1 },
  { name: 'typical 4G (5 Mbps up)', mbps: 5 },
  { name: 'home Wi-Fi (20 Mbps up)', mbps: 20 },
];

function prices(): { input: number; output: number } | null {
  const input = Number(settings.value('GEMINI_INPUT_USD_PER_MTOK'));
  const output = Number(settings.value('GEMINI_OUTPUT_USD_PER_MTOK'));
  return input > 0 && output > 0 ? { input, output } : null;
}

function costOf(r: AnswerRecord, p: { input: number; output: number }): number {
  // Thinking tokens are billed at the output rate.
  return (r.inputTokens * p.input + (r.outputTokens + r.thinkingTokens) * p.output) / 1_000_000;
}

/**
 * Ask the same question `times` times, each in a fresh thread (earlier turns
 * would add cost and time), and record what each answer cost and how long it took.
 */
async function measure(world: ImageWorld, question: string, makeImages: () => Promise<ImageInput[]>, times: number) {
  const feature = world.feature.startsWith('Cost') ? 'cost' : 'latency';
  const p = prices();
  world.runs = [];
  for (let i = 0; i < times; i++) {
    const threadId = await createThread(world.baseUrl, world.token);
    const images = await makeImages();
    const result = await ask(world.baseUrl, world.token, threadId, question, images);
    assert.equal(result.error, null, `run ${i + 1} failed (status ${result.status}): ${result.error}`);
    const record = await latestAnswerRecord(threadId);
    world.runs.push({ threadId, images: images.length, result, record });

    addRow(
      'Measured answers',
      ['Feature', 'Question', 'Images', 'Run', 'Model', 'Input tok', 'Output tok', 'Thinking tok', 'Cost', 'First word', 'Full answer', 'Upload'],
      [
        feature,
        question.length > 50 ? `${question.slice(0, 50)}…` : question,
        images.length,
        i + 1,
        record?.modelId ?? '?',
        record?.inputTokens ?? '?',
        record?.outputTokens ?? '?',
        record?.thinkingTokens ?? '?',
        record && p ? fmt.usd(costOf(record, p)) : 'set prices',
        fmt.sec(result.firstWordMs),
        fmt.sec(result.totalMs),
        fmt.mb(result.uploadBytes),
      ],
      'Each run is a fresh thread. Tokens are what the server recorded for the whole answer (all model calls).'
    );
  }
}

When(
  /^I ask "(.*)" with (\d+) photo-sized images, (\d+) times$/,
  async function (this: ImageWorld, question: string, imageCount: string, times: string) {
    await measure(
      this,
      question,
      async () => Promise.all(randomNumbers(Number(imageCount)).map(async (n) => toInput(await numberedImage(n)))),
      Number(times)
    );
  }
);

When(
  /^I ask "(.*)" with the fixture image "(.*)", (\d+) times$/,
  async function (this: ImageWorld, question: string, name: string, times: string) {
    const fixture = loadTextFixtures().find((f) => f.name === name);
    assert.ok(fixture, `no fixture image named ${name} in ${FIXTURE_DIR}`);
    // Sent the way the app sends a picked photo.
    const jpeg = await shrinkLikeTheApp(fixture.image, APP_MAX_EDGE);
    await measure(this, question, async () => [toInput(jpeg)], Number(times));
  }
);

When(/^I ask "(.*)" with no images, (\d+) times$/, async function (this: ImageWorld, question: string, times: string) {
  await measure(this, question, async () => [], Number(times));
});

Then('the median cost of one answer is at most ${float}', function (this: ImageWorld, max: number) {
  requireSettings(['GEMINI_INPUT_USD_PER_MTOK', 'GEMINI_OUTPUT_USD_PER_MTOK'], 'cost');
  const p = prices()!;
  const costs = this.runs.map((r) => {
    assert.ok(r.record, `no answer was recorded for thread ${r.threadId}`);
    return costOf(r.record, p);
  });
  const m = median(costs);
  addRow('Cost summary', ['Images', 'Median cost', 'Limit', 'Runs'], [this.runs[0].images, fmt.usd(m), fmt.usd(max), costs.map(fmt.usd).join(', ')]);
  assert.ok(m <= max, `median cost ${fmt.usd(m)} is over the ${fmt.usd(max)} limit`);
});

Then('the median time to the first word is at most {float} seconds', function (this: ImageWorld, max: number) {
  const times = this.runs.map((r) => r.result.firstWordMs ?? Infinity);
  const m = median(times);
  const total = median(this.runs.map((r) => r.result.totalMs));
  const upload = Math.max(...this.runs.map((r) => r.result.uploadBytes));
  addRow(
    'Latency summary',
    ['Images', 'Median first word', 'Median full answer', 'Upload', ...CONNECTIONS.map((c) => `Upload time, ${c.name}`)],
    [
      this.runs[0].images,
      fmt.sec(m),
      fmt.sec(total),
      fmt.mb(upload),
      ...CONNECTIONS.map((c) => fmt.sec(((upload * 8) / (c.mbps * 1_000_000)) * 1000)),
    ],
    'Measured on this machine against the real model. Upload times are computed from the body size, not measured; on a phone they add to "first word".'
  );
  assert.ok(m <= max * 1000, `median time to the first word is ${fmt.sec(m)}, over ${max}s`);
});

Then('the median time to the full answer is at most {float} seconds', function (this: ImageWorld, max: number) {
  const m = median(this.runs.map((r) => r.result.totalMs));
  assert.ok(m <= max * 1000, `median time to the full answer is ${fmt.sec(m)}, over ${max}s`);
});

Then('the upload is at most {float} MB', function (this: ImageWorld, max: number) {
  const upload = Math.max(...this.runs.map((r) => r.result.uploadBytes));
  assert.ok(upload <= max * 1024 * 1024, `the request body is ${fmt.mb(upload)}, over ${max} MB`);
});
