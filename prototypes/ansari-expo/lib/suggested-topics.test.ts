import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SUGGESTED_TOPICS } from './suggested-topics';

// The home screen flattens the topics in array order (#243): a desktop shows
// the first three as sample lines, a phone shows every question as a chip.
const flattened = SUGGESTED_TOPICS.flatMap((topic) => topic.questions);

describe('suggested topics', () => {
  it('leads with the showcase trio the desktop shows', () => {
    expect(flattened.slice(0, 3)).toEqual([
      'How do I perform wudu correctly?',
      'Is investing in cryptocurrency permissible in Islam?',
      'What’s one small step I can take to strengthen my faith?',
    ]);
  });

  it('names the leading topic without promising a single theme', () => {
    expect(SUGGESTED_TOPICS[0].topic).not.toBe('Prayer');
  });

  it('keeps the Qur’an and everyday-life questions for the phone shelf', () => {
    expect(SUGGESTED_TOPICS.map((t) => t.topic)).toEqual([
      SUGGESTED_TOPICS[0].topic,
      "Qur'an",
      'Everyday life',
    ]);
    expect(flattened).toHaveLength(7);
    expect(new Set(flattened).size).toBe(flattened.length);
  });
});

// A source scan: the mark is a Feather glyph name inside a component that
// only renders on the home screen, and nothing behind the list is a trend.
describe('suggestion line mark', () => {
  const source = readFileSync(path.resolve(__dirname, '..', 'app/index.tsx'), 'utf8');

  it('draws a compass, not a trend line', () => {
    expect(source).toMatch(/<Feather name="compass"/);
    expect(source).not.toMatch(/trending-up/);
  });
});
