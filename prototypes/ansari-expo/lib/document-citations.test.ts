import { describe, expect, it } from 'vitest';
import type { WireDocument } from '@/lib/api/wire-schemas';
import { resolveCitations } from '@/lib/document-citations';

// Fixtures shaped exactly as apps/api/lib/tools/search-*.ts builds them.
const doc = (title: string, context: string, data: string): WireDocument => ({
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data },
  title,
  context,
});

const quran = (ref: string, ar: string, en: string) =>
  doc(`Quran ${ref}`, 'Retrieved from the Holy Quran', JSON.stringify({ ar, en }));

const hadith = (lkId: string, number: string) =>
  doc(
    `Sahih al-Bukhari - Chapter 9: Times of the Prayers, Hadith ${number} (Grade: Sahih) (LK id ${lkId})`,
    'Retrieved from hadith collections',
    JSON.stringify({
      ar: 'أَرَأَيْتُمْ لَوْ أَنَّ نَهَرًا',
      en: 'If there was a river at the door…',
      grade: 'Sahih',
      collection: 'Sahih al-Bukhari',
      chapter: 'Times of the Prayers',
      lk_id: lkId,
    }),
  );

const tafsir = (volume: number, page: number, data: string) =>
  doc(
    `Tafsir Encyclopedia, Volume ${volume}, Page ${page}`,
    'Retrieved from Encyclopedia of Evidence-based Tafsir',
    data,
  );

const mawsuah = (volume: number, page: number, data: string) =>
  doc(
    `Encyclopedia of Islamic Jurisprudence, Volume ${volume}, Page ${page}`,
    'Retrieved from Encyclopedia of Islamic Jurisprudence',
    data,
  );

const Q_20_14 = quran('20:14', 'وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ', 'And establish prayer for My remembrance.');
const Q_23_1 = quran('23:1', 'قَدْ أَفْلَحَ ٱلْمُؤْمِنُونَ', 'Certainly will the believers have succeeded.');
const H_528 = hadith('2_9_6_528', '528');
const T_3_12 = tafsir(3, 12, 'Chapter: On prayer\n\nPrayer is the pillar of the religion.');
const M_27_50 = mawsuah(27, 50, 'الخشوع في الصلاة هو حضور القلب');

const markers = (content: string) =>
  [...content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));

describe('document → Citation field mapping', () => {
  const all = resolveCitations('Answer.', [Q_20_14, H_528, T_3_12, M_27_50], 'm').citations;

  it('maps a Qur\'an verse, with a quran.com link', () => {
    expect(all[0]).toEqual({
      id: 'm-doc-0',
      marker: 1,
      sourceType: 'quran',
      reference: "Qur'an 20:14",
      sourceTitle: "The Holy Qur'an",
      arabicText: 'وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ',
      translationText: 'And establish prayer for My remembrance.',
      url: 'https://quran.com/20/14',
    });
  });

  it('maps a hadith, without the LK id token and without a guessed link', () => {
    expect(all[1]).toEqual({
      id: 'm-doc-1',
      marker: 2,
      sourceType: 'hadith',
      reference: 'Sahih al-Bukhari 528',
      sourceTitle: 'Times of the Prayers · Grade: Sahih',
      arabicText: 'أَرَأَيْتُمْ لَوْ أَنَّ نَهَرًا',
      translationText: 'If there was a river at the door…',
    });
    expect(all[1]!.url).toBeUndefined();
  });

  it('maps an English tafsir passage, lifting its chapter line', () => {
    expect(all[2]).toMatchObject({
      sourceType: 'scholarly',
      reference: 'Tafsir Encyclopedia, Volume 3, Page 12',
      sourceTitle: 'Encyclopedia of Evidence-based Tafsir — On prayer',
      translationText: 'Prayer is the pillar of the religion.',
    });
    expect(all[2]!.arabicText).toBeUndefined();
  });

  it('shows an Arabic encyclopedia passage as Arabic', () => {
    expect(all[3]).toMatchObject({
      sourceType: 'scholarly',
      reference: 'Encyclopedia of Islamic Jurisprudence, Volume 27, Page 50',
      sourceTitle: 'Encyclopedia of Islamic Jurisprudence',
      arabicText: 'الخشوع في الصلاة هو حضور القلب',
      translationText: '',
    });
  });

  it('falls back to the raw text when a Qur\'an payload is not JSON', () => {
    const [c] = resolveCitations('x', [doc('Quran 1:1', 'Retrieved from the Holy Quran', 'not json')], 'm').citations;
    expect(c).toMatchObject({ sourceType: 'quran', reference: 'Quran 1:1', translationText: 'not json' });
  });

  it('falls back to a scholarly citation for an unknown source', () => {
    const [c] = resolveCitations('x', [doc('Some Work', 'Retrieved elsewhere', 'Passage.')], 'm').citations;
    expect(c).toMatchObject({
      sourceType: 'scholarly',
      reference: 'Some Work',
      sourceTitle: 'Retrieved elsewhere',
      translationText: 'Passage.',
    });
  });

  it('sets no Qur\'an link when the title does not parse as surah:ayah', () => {
    const [c] = resolveCitations('x', [quran('2:255-256', 'a', 'b')], 'm').citations;
    expect(c!.url).toBeUndefined();
  });
});

describe('resolving the model\'s inline markers', () => {
  it('ties each marker to the document its Citations entry names, not its position', () => {
    // The model numbers the hadith [1] and the verse [2]; documents are in the
    // opposite order.
    const { content, citations } = resolveCitations(
      'Five prayers wash sins away [1]. Establish prayer for remembrance [2].\n\n' +
        '**Citations**:\n' +
        '[1] Sahih al-Bukhari - Chapter 9, Hadith 528 (LK id 2_9_6_528)\n' +
        '    Arabic: …\n    English: …\n' +
        "[2] Qur'an 20:14\n",
      [Q_20_14, H_528],
      'm',
    );
    expect(content).toBe(
      'Five prayers wash sins away [1]. Establish prayer for remembrance [2].',
    );
    expect(citations.map((c) => [c.marker, c.reference])).toEqual([
      [1, 'Sahih al-Bukhari 528'],
      [2, "Qur'an 20:14"],
    ]);
  });

  it('renumbers by first appearance, with no gaps, and pills share the numbers', () => {
    const { content, citations } = resolveCitations(
      'Humility [3]. Remembrance [1]. Again humility [3].\n\nCitations:\n' +
        "1. Qur'an 20:14\n2. Something the model made up\n3. Qur'an 23:1\n",
      [Q_20_14, Q_23_1],
      'm',
    );
    expect(content).toBe('Humility [1]. Remembrance [2]. Again humility [1].');
    expect(citations.map((c) => [c.marker, c.reference])).toEqual([
      [1, "Qur'an 23:1"],
      [2, "Qur'an 20:14"],
    ]);
  });

  it('strips only the marker whose entry does not resolve', () => {
    const { content } = resolveCitations(
      'Remembrance [1]. Unsupported claim [2].\n\nCitations:\n' +
        "[1] Qur'an 20:14\n[2] Sahih Muslim 979\n",
      [Q_20_14],
      'm',
    );
    expect(content).toBe('Remembrance [1]. Unsupported claim.');
  });

  it('does not link a hadith whose LK id is wrong, even if the title matches', () => {
    const { content, citations } = resolveCitations(
      'Wash [1]. Remember [2].\n\nCitations:\n' +
        '[1] Sahih al-Bukhari - Chapter 9, Hadith 528 (LK id 2_9_6_999)\n' +
        "[2] Qur'an 20:14\n",
      [H_528, Q_20_14],
      'm',
    );
    expect(content).toBe('Wash. Remember [1].');
    expect(citations[0]!.reference).toBe("Qur'an 20:14");
  });

  it('treats an entry that names two documents as unresolved', () => {
    const { content } = resolveCitations(
      "Both verses [1]. One verse [2].\n\nCitations:\n[1] Qur'an 20:14, 23:1\n[2] Qur'an 23:1\n",
      [Q_20_14, Q_23_1],
      'm',
    );
    expect(content).toBe('Both verses. One verse [1].');
  });

  it('resolves an encyclopedia entry by work, volume and page', () => {
    const { citations } = resolveCitations(
      'Point [1].\n\nCitations:\n[1] Encyclopedia of Islamic Jurisprudence, Volume 27, Page 50\n',
      [T_3_12, M_27_50],
      'm',
    );
    expect(citations[0]!.reference).toBe('Encyclopedia of Islamic Jurisprudence, Volume 27, Page 50');
  });

  it('does not match a tafsir entry to a jurisprudence page with the same numbers', () => {
    const { content } = resolveCitations(
      'Point [1].\n\nCitations:\n[1] Tafsir Encyclopedia, Volume 27, Page 50\n',
      [M_27_50, Q_20_14],
      'm',
    );
    // Nothing resolved → fallback: no markers, document order.
    expect(content).toBe('Point.');
  });

  it('lists uncited documents after the cited ones', () => {
    const { citations } = resolveCitations(
      "Remember [1].\n\nCitations:\n[1] Qur'an 20:14\n",
      [H_528, Q_20_14, T_3_12],
      'm',
    );
    expect(citations.map((c) => [c.marker, c.id])).toEqual([
      [1, 'm-doc-1'],
      [2, 'm-doc-0'],
      [3, 'm-doc-2'],
    ]);
  });

  it('keeps a [N](url) link label untouched', () => {
    const { content } = resolveCitations(
      "See [1](https://quran.com) and [1].\n\nCitations:\n[1] Qur'an 20:14\n",
      [Q_20_14],
      'm',
    );
    expect(content).toBe('See [1](https://quran.com) and [1].');
  });

  it('always removes the Citations section', () => {
    const { content } = resolveCitations(
      "Remember [1].\n\n## Citations\n[1] Qur'an 20:14\n    Arabic: …\n",
      [Q_20_14],
      'm',
    );
    expect(content).not.toMatch(/citations/i);
  });

  it('falls back when there is no Citations list: every marker removed, document order', () => {
    const { content, citations } = resolveCitations(
      'Remember [1]. Wash [2].',
      [H_528, Q_20_14],
      'm',
    );
    expect(content).toBe('Remember. Wash.');
    expect(markers(content)).toEqual([]);
    expect(citations.map((c) => c.reference)).toEqual(['Sahih al-Bukhari 528', "Qur'an 20:14"]);
  });

  it('falls back when no entry matches', () => {
    const { content, citations } = resolveCitations(
      'Claim [1].\n\nCitations:\n[1] Sahih Muslim 979\n',
      [Q_20_14],
      'm',
    );
    expect(content).toBe('Claim.');
    expect(citations).toHaveLength(1);
  });

  it('resolves by exact title when the entry carries no stronger key', () => {
    const other = doc('Riyad as-Salihin 1', 'Retrieved elsewhere', 'Passage.');
    const { content, citations } = resolveCitations(
      'Claim [1].\n\nCitations:\n[1] Riyad as-Salihin 1\n',
      [Q_20_14, other],
      'm',
    );
    expect(content).toBe('Claim [1].');
    expect(citations[0]!.reference).toBe('Riyad as-Salihin 1');
  });
});
