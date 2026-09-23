import { describe, expect, it } from 'vitest';
import {
  stripStreamingCitations,
  stripUnbackedCitations,
} from '@/lib/citations';

const PROSE = 'Slow down enough to notice what you are reciting.';

describe('stripUnbackedCitations', () => {
  it.each([
    ['plain', 'Citations:'],
    ['bold', '**Citations:**'],
    ['bold, colon outside', '**Citations**:'],
    ['underscore bold', '__Citations:__'],
    ['ATX heading', '## Citations'],
    ['no colon', 'Citations'],
    ['uppercase', 'CITATIONS:'],
  ])('cuts a trailing %s heading and everything after it', (_, heading) => {
    const content = `${PROSE}\n\n${heading}\n1. Qur'an 20:14\n2. Bukhari 528\n`;
    expect(stripUnbackedCitations(content)).toBe(PROSE);
  });

  it('keeps prose that merely mentions citations mid-sentence', () => {
    const content = 'The scholars list citations: the Qur\'an and the Sunnah.';
    expect(stripUnbackedCitations(content)).toBe(content);
  });

  it('removes bare markers with the space before them', () => {
    expect(stripUnbackedCitations('Establish prayer [1]. Be humble [2][3].')).toBe(
      'Establish prayer. Be humble.',
    );
    expect(stripUnbackedCitations('Establish prayer[1].')).toBe(
      'Establish prayer.',
    );
  });

  it('removes markers and the section together', () => {
    const content = `${PROSE} [1]\n\n**Citations:**\n[1] Qur'an 20:14`;
    expect(stripUnbackedCitations(content)).toBe(PROSE);
  });

  it('leaves text with no citation shapes unchanged', () => {
    expect(stripUnbackedCitations(PROSE)).toBe(PROSE);
    expect(stripUnbackedCitations('')).toBe('');
  });

  it('leaves bracket near-misses alone', () => {
    const content = 'See [a], [] and [1a] and array[i].';
    expect(stripUnbackedCitations(content)).toBe(content);
  });
});

const ANSWER =
  'Zakat is due on wealth held a lunar year above the nisab [1]. ' +
  'The rate is 2.5% [2][3].\n\n- Gold: 85g\n- Silver: 595g\n\n' +
  "**Citations:**\n\n[1] Qur'an 9:60\n[2] Bukhari 1447\n[3] Abi Dawud 1573\n";

/** Replays the thread's onEvent path: display = clean(whole raw so far). */
function frames(text: string, size: number) {
  const shown: string[] = [];
  for (let end = size; end < text.length + size; end += size) {
    shown.push(stripStreamingCitations(text.slice(0, end)));
  }
  return shown;
}

describe('stripStreamingCitations', () => {
  it.each([1, 3, 7, 16])(
    'never shows a half-written marker or heading (chunks of %i)',
    (size) => {
      for (const frame of frames(ANSWER, size)) {
        expect(frame).not.toMatch(/\[\d*\]?$|\[\d+\]|\bcit\w*:?\**$/i);
      }
    },
  );

  it.each([1, 3, 7, 16])(
    'ends exactly where the persisted answer does (chunks of %i)',
    (size) => {
      expect(frames(ANSWER, size).at(-1)).toBe(
        stripUnbackedCitations(ANSWER),
      );
    },
  );

  it('holds back an unfinished tail, and shows it once it proves to be prose', () => {
    expect(stripStreamingCitations('above the nisab [1')).toBe(
      'above the nisab',
    );
    expect(stripStreamingCitations('595g\n\n**Citat')).toBe('595g');
    expect(stripStreamingCitations('595g\n\nCit')).toBe('595g');
    expect(stripStreamingCitations('595g\n\nCiting the hadith')).toBe(
      '595g\n\nCiting the hadith',
    );
  });
});
