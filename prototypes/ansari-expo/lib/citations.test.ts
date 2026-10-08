import { describe, expect, it } from 'vitest';
import {
  stripInlineCitationMetadata,
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

/**
 * The answer from issue #251's screenshot: the model's own "Evidence:" list,
 * each source quoted with its raw LK id beside the proper `[N]` marker.
 */
const EVIDENCE_ANSWER =
  'One small step: guard the five prayers on time.\n\n' +
  '**Evidence:**\n\n' +
  '- Hadith (Sahih Bukhari) — "The most beloved deed to Allah is the most regular and constant even if it were little." (LK id 1_77_43_5861) [1]\n' +
  '- Hadith (Sunan Abi Dawud) — "The first matter the servant will be brought to account for is the prayer." (LK id 2_6_30_1807) [2]\n' +
  '- Hadith (Sunan Ibn Majah) — "Take on only as much as you can do of good deeds." (LK id 4_37_-1_4298) [3]\n\n' +
  '**Citations:**\n' +
  '[1] Sahih al-Bukhari, Hadith 5861 (LK id 1_77_43_5861)\n' +
  '[2] Sunan Abi Dawud, Hadith 1807 (LK id 2_6_30_1807)\n' +
  '[3] Sunan Ibn Majah, Hadith 4298 (LK id 4_37_-1_4298)\n';

describe('stripInlineCitationMetadata', () => {
  it('scrubs every LK id from the screenshot answer, -1 segment included', () => {
    const shown = stripUnbackedCitations(EVIDENCE_ANSWER);
    expect(shown).not.toMatch(/LK id|1_77_43_5861|2_6_30_1807|4_37_-1_4298/);
    expect(shown).toBe(
      'One small step: guard the five prayers on time.\n\n' +
        '**Evidence:**\n\n' +
        '- Hadith (Sahih Bukhari) — "The most beloved deed to Allah is the most regular and constant even if it were little."\n' +
        '- Hadith (Sunan Abi Dawud) — "The first matter the servant will be brought to account for is the prayer."\n' +
        '- Hadith (Sunan Ibn Majah) — "Take on only as much as you can do of good deeds."',
    );
  });

  it.each([
    ['parenthetical', 'Be regular (LK id 1_77_43_5861) [1].', 'Be regular [1].'],
    ['colon', 'Be regular (LK id: 4_37_-1_4298).', 'Be regular.'],
    ['square brackets', 'Be regular [LK id 2_6_30_1807].', 'Be regular.'],
    ['any case', 'Be regular (lk ID 2_6_30_1807).', 'Be regular.'],
    ['two ids', 'Be regular (LK id 1_2_3_4, LK id 5_6_-1_8).', 'Be regular.'],
    ['beside a source, after', 'Be regular (Bukhari, LK id 1_2_3_4).', 'Be regular (Bukhari).'],
    ['beside a source, before', 'Be regular (LK id 1_2_3_4; Bukhari).', 'Be regular (Bukhari).'],
    ['after a dash', 'Be regular — LK id 1_2_3_4.', 'Be regular.'],
    ['bare', 'Be regular LK id 1_2_3_4 always.', 'Be regular always.'],
  ])('removes an inline id: %s', (_, body, expected) => {
    expect(stripInlineCitationMetadata(body)).toBe(expected);
  });

  it.each([
    'Scholars use a hadith ID system to number each report.',
    'The LK collection numbers its hadith; the id is internal.',
    'See Tafsir Ibn Kathir, Volume 3, Page 45 (vol. 3, p. 45).',
    'Linked (Bukhari 5861) and BLK id 12 and LKid 1_2_3.',
  ])('leaves a near-miss alone: %s', (prose) => {
    expect(stripInlineCitationMetadata(prose)).toBe(prose);
  });

  it.each([1, 3, 7, 16])(
    'never shows a half-written id while streaming (chunks of %i)',
    (size) => {
      const shown = frames(EVIDENCE_ANSWER, size);
      for (const frame of shown) expect(frame).not.toMatch(/\bLK\b|\(L$|\d_\d/i);
      expect(shown.at(-1)).toBe(stripUnbackedCitations(EVIDENCE_ANSWER));
    },
  );

  it('shows a held-back L once it proves to be prose', () => {
    expect(stripStreamingCitations('a little (L')).toBe('a little');
    expect(stripStreamingCitations('a little (Lo')).toBe('a little (Lo');
    expect(stripStreamingCitations('a little (LK id 1_77')).toBe('a little');
  });
});
