import { describe, expect, it } from 'vitest';
import { SURAH_COUNT, surahName } from '@/lib/surah-names';

describe('surahName', () => {
  it('has one name per surah', () => {
    expect(SURAH_COUNT).toBe(114);
  });

  it('names surahs across the table', () => {
    expect(surahName(1)).toBe('Al-Fatihah');
    expect(surahName(17)).toBe('Al-Isra');
    expect(surahName(36)).toBe('Ya-Sin');
    expect(surahName(73)).toBe('Al-Muzzammil');
    expect(surahName(114)).toBe('An-Nas');
  });

  it('has no name outside 1–114', () => {
    expect(surahName(0)).toBeUndefined();
    expect(surahName(115)).toBeUndefined();
    expect(surahName(1.5)).toBeUndefined();
  });
});
