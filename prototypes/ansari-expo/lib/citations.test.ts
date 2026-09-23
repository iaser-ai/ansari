import { describe, expect, it } from 'vitest';
import { stripUnbackedCitations } from '@/lib/citations';

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
