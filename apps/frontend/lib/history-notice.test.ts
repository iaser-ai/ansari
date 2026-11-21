import { describe, expect, it } from 'vitest';
import type { WireDocument, WireMessage } from '@/lib/api/wire-schemas';
import { mapMessage } from '@/lib/api/mappers';
import { stripStreamingCitations, stripUnbackedCitations } from '@/lib/citations';
import { resolveCitations } from '@/lib/document-citations';
import { answerDirection } from '@/lib/script';

/**
 * The thread-history warning on the screen (issue #400).
 *
 * apps/api adds a notice to the answers of a long thread, as ordinary answer
 * text. This app cuts a "Citations" heading and everything after it from what
 * it shows, so a notice placed after the answer was removed from every answer
 * that cited a source, live and on re-read. apps/api therefore sends it as the
 * answer's FIRST paragraph. These tests put that text through the functions the
 * chat screen and the mappers really use, and pin the old placement as lost, so
 * the method is shown to see the loss.
 *
 * The sentence is apps/api's HISTORY_WARNING_MESSAGE
 * (apps/api/lib/facilitator/history-limit.ts); apps/api/tests/history-limit.test.ts
 * pins the same words, so a rewording has to visit both.
 */
const WARNING =
  'Note: this conversation is getting long. Please start a new conversation soon. Ansari cannot continue a conversation beyond a certain length.';

const BODY = 'Five prayers wash sins away [1]. Establish prayer for remembrance [2].';
const CITATIONS =
  '**Citations**:\n' +
  '[1] Sahih al-Bukhari - Chapter 9, Hadith 528 (LK id 2_9_6_528)\n' +
  '    Arabic: …\n    English: …\n' +
  "[2] Qur'an 20:14\n";

/** What apps/api stores and streams for a warned, cited answer. */
const WARNED = `${WARNING}\n\n${BODY}\n\n${CITATIONS}`;
/** The placement this replaced: the notice after the answer, so after its citations. */
const WARNED_AFTER = `${BODY}\n\n${CITATIONS}\n\n${WARNING}`;

// Fixtures shaped as apps/api/lib/tools/search-*.ts builds them.
const doc = (title: string, context: string, data: string): WireDocument => ({
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data },
  title,
  context,
});
const Q_20_14 = doc(
  'Quran 20:14',
  'Retrieved from the Holy Quran',
  JSON.stringify({ ar: 'وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ', en: 'And establish prayer for My remembrance.' }),
);
const H_528 = doc(
  'Sahih al-Bukhari - Chapter 9: Times of the Prayers, Hadith 528 (Grade: Sahih) (LK id 2_9_6_528)',
  'Retrieved from hadith collections',
  JSON.stringify({
    ar: 'أَرَأَيْتُمْ لَوْ أَنَّ نَهَرًا',
    en: 'If there was a river at the door…',
    grade: 'Sahih',
    collection: 'Sahih al-Bukhari',
    chapter: 'Times of the Prayers',
    lk_id: '2_9_6_528',
  }),
);

const stored = (content: string): WireMessage =>
  ({ id: 'm1', role: 'assistant', content, created_at: '2026-11-17T00:00:00.000Z' }) as WireMessage;

describe('a warned answer with a Citations section keeps its warning', () => {
  it('re-read with its source documents: the warning opens the answer, the markers resolve', () => {
    const { content, citations } = resolveCitations(WARNED, [Q_20_14, H_528], 'm1');
    expect(content).toBe(`${WARNING}\n\n${BODY}`);
    expect(citations.map((c) => c.marker)).toEqual([1, 2]);
  });

  it('re-read through the message mapper, as the thread screen gets it', () => {
    const message = mapMessage(stored(WARNED), 'c1', [Q_20_14, H_528]);
    expect(message?.content).toBe(`${WARNING}\n\n${BODY}`);
    expect(message?.citations).toHaveLength(2);
  });

  it('re-read with documents none of which the section names: still there', () => {
    const { content } = resolveCitations(WARNED, [doc('Quran 2:255', 'Retrieved from the Holy Quran', '{}')], 'm1');
    expect(content.startsWith(`${WARNING}\n\n`)).toBe(true);
    expect(content).not.toContain('Citations');
  });

  it('re-read with no documents at all: still there', () => {
    expect(stripUnbackedCitations(WARNED)).toBe(
      `${WARNING}\n\nFive prayers wash sins away. Establish prayer for remembrance.`,
    );
  });

  it('while it streams: shown whole from the moment it has arrived, at every later length', () => {
    const arrived = WARNING.length;
    let shownAt = 0;
    for (let length = arrived; length <= WARNED.length; length++) {
      const shown = stripStreamingCitations(WARNED.slice(0, length));
      if (shown.startsWith(WARNING)) shownAt++;
      else throw new Error(`warning missing at stream length ${length}: ${JSON.stringify(shown.slice(0, 60))}`);
    }
    expect(shownAt).toBe(WARNED.length - arrived + 1);
    expect(stripStreamingCitations(WARNED)).toBe(
      `${WARNING}\n\nFive prayers wash sins away. Establish prayer for remembrance.`,
    );
  });

  it('is not read as a Citations heading, on its own line or as the whole answer so far', () => {
    expect(stripUnbackedCitations(WARNING)).toBe(WARNING);
    expect(stripStreamingCitations(`${WARNING}\n\n`)).toBe(WARNING);
  });
});

describe('the placement it replaced: a warning after the Citations section is cut with it', () => {
  it('on every display path', () => {
    expect(resolveCitations(WARNED_AFTER, [Q_20_14, H_528], 'm1').content).not.toContain(WARNING);
    expect(mapMessage(stored(WARNED_AFTER), 'c1', [Q_20_14, H_528])?.content).not.toContain(WARNING);
    expect(stripUnbackedCitations(WARNED_AFTER)).not.toContain(WARNING);
    expect(stripStreamingCitations(WARNED_AFTER)).not.toContain(WARNING);
  });
});

describe('an English warning ahead of an Arabic answer', () => {
  const SENTENCE = 'الصبر هو حبس النفس على ما تكره ابتغاء مرضاة الله تعالى، وهو من أعظم أخلاق المؤمنين.';

  it('an answer of ordinary length still reads right-to-left', () => {
    const answer = Array.from({ length: 6 }, () => SENTENCE).join(' ');
    expect(answerDirection(answer)).toBe('rtl');
    expect(answerDirection(`${WARNING}\n\n${answer}`)).toBe('rtl');
  });

  it('a one-sentence answer is outweighed by it and reads left-to-right: a known cost', () => {
    expect(answerDirection(SENTENCE)).toBe('rtl');
    expect(answerDirection(`${WARNING}\n\n${SENTENCE}`)).toBe('ltr');
  });
});
