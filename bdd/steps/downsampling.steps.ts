import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import sharp from 'sharp';
import { ask, createThread } from '../support/api.ts';
import { FIXTURE_DIR, loadTextFixtures, shrinkLikeTheApp, toInput } from '../support/images.ts';
import { addRow, fmt } from '../support/report.ts';
import { hasDiacritics, wordRecall } from '../support/text-score.ts';
import type { ImageWorld } from '../support/world.ts';

const PROMPT =
  'Copy out all of the text in this image exactly as written, including every diacritic (tashkeel). ' +
  'Reply with the text only, nothing else.';

When(
  /^the model copies out the text of every fixture image shrunk to (\d+ px|original)$/,
  async function (this: ImageWorld, size: string) {
    const fixtures = loadTextFixtures();
    assert.ok(
      fixtures.length > 0,
      `no text images found: put images with a same-named .txt of their exact text in ${FIXTURE_DIR}`
    );
    const maxEdge = size === 'original' ? null : Number.parseInt(size, 10);
    const model = this.profile === 'inkling-primary' ? 'Inkling' : 'Gemini';
    this.recalls = [];
    const failures: string[] = [];

    for (const fixture of fixtures) {
      const jpeg = await shrinkLikeTheApp(fixture.image, maxEdge);
      const { width, height } = await sharp(jpeg).metadata();
      const threadId = await createThread(this.baseUrl, this.token);
      const result = await ask(this.baseUrl, this.token, threadId, PROMPT, [toInput(jpeg)]);
      const failed = result.error !== null || result.status !== 200;
      if (failed) failures.push(`${fixture.name}: ${result.status} ${result.error}`);
      const words = failed ? 0 : wordRecall(fixture.text, result.text, false);
      const marked = failed ? 0 : wordRecall(fixture.text, result.text, true);
      this.recalls.push({ words, marked });

      addRow(
        'Reading text after shrinking',
        ['Model', 'Size', 'Image', 'Sent as', 'Words read (no diacritics)', 'Words read (with diacritics)', 'Answer starts', 'Note'],
        [
          model,
          size,
          fixture.name,
          `${width}×${height}, ${fmt.mb(jpeg.length)}`,
          fmt.pct(words),
          hasDiacritics(fixture.text) ? fmt.pct(marked) : 'n/a (no diacritics)',
          // Enough of the answer to see WHAT the model chose to copy.
          result.text.replace(/\s+/g, ' ').trim().slice(0, 120),
          failed ? `failed: ${result.status} ${result.error}` : '',
        ],
        'Share of the real words found in the answer. "Original" is the full-size image re-saved as JPEG 0.8 with no shrinking.'
      );
    }

    // When nothing was read, the reason is the request, not the reading: say so
    // instead of letting the next step report a misleading 0%.
    assert.ok(
      failures.length < fixtures.length,
      `every request failed, so nothing was measured. First error: ${failures[0]?.slice(0, 400)}`
    );
  }
);

function average(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

Then(
  'on average at least {int}% of the words are read correctly, ignoring diacritics',
  function (this: ImageWorld, min: number) {
    const avg = average(this.recalls.map((r) => r.words));
    assert.ok(avg * 100 >= min, `on average ${fmt.pct(avg)} of words were read, below ${min}%`);
  }
);

Then(
  'on average at least {int}% of the words are read correctly, with diacritics',
  function (this: ImageWorld, min: number) {
    const avg = average(this.recalls.map((r) => r.marked));
    assert.ok(avg * 100 >= min, `on average ${fmt.pct(avg)} of words were read with their diacritics, below ${min}%`);
  }
);
