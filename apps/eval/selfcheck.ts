/**
 * Does the Quran scorer catch a misquote in the answers of a real run?
 *
 *   pnpm --filter ansari-eval exec -- tsx selfcheck.ts <results.json>
 *
 * A run in which no quote fails is only good news if a failing quote would have been
 * seen. This takes every answer in a results file that has a correctly quoted verse of
 * five words or more, corrupts that one quote two ways (swaps two neighbouring words;
 * drops a word), scores the corrupted answer, and reports how many corruptions the scorer
 * failed (`mismatch` or `wrong_reference`), how many it only listed for a person to read
 * (`suspect`), and how many it missed. No model is called and the file is not changed.
 *
 * Exits 1 if any corruption is missed outright.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scoreRun } from './lib/score';
import { HARD_FAIL, type QuoteOutcome } from './lib/score-quran';
import type { RunFile, TurnRecord } from './lib/types';

type Verdict = 'failed' | 'listed' | 'missed';
type Mutation = 'swap' | 'drop';

/** A word of the verse, not a pause mark standing alone. */
const HAS_LETTER = /[ء-يٱ]/u;

function corrupt(text: string, how: Mutation): string | null {
  const words = text.split(/\s+/u);
  const lettered = words.flatMap((w, i) => (HAS_LETTER.test(w) ? [i] : []));
  if (lettered.length < 5) return null;
  const pick = Math.floor(lettered.length / 2);
  const at = lettered[pick];
  const before = lettered[pick - 1];
  if (how === 'drop') return [...words.slice(0, at), ...words.slice(at + 1)].join(' ');
  if (words[at] === words[before]) return null;
  const out = [...words];
  [out[before], out[at]] = [out[at], out[before]];
  return out.join(' ');
}

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx selfcheck.ts <results.json>');
  process.exit(2);
}
const run = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as RunFile;
// Score with the scorers as they are now, whatever the file was last scored with.
scoreRun(run);

const tally: Record<Mutation, Record<Verdict, number>> = {
  swap: { failed: 0, listed: 0, missed: 0 },
  drop: { failed: 0, listed: 0, missed: 0 },
};
const notFailed: string[] = [];

for (const record of run.records) {
  if (record.outcome !== 'ok' || !record.scores) continue;
  const quote = record.scores.quran.quotes.find((q) => q.outcome === 'exact' && q.words >= 5);
  if (!quote) continue;
  const conversation = (r: TurnRecord) => r.model === record.model && r.questionId === record.questionId && r.repeat === record.repeat;
  for (const how of ['swap', 'drop'] as const) {
    const bad = corrupt(quote.text, how);
    if (bad === null) continue;
    const copy: RunFile = {
      ...run,
      records: run.records.filter(conversation).map((r) => (r === record ? { ...r, answer: r.answer.replace(quote.text, bad) } : { ...r })),
    };
    scoreRun(copy);
    const before: Record<QuoteOutcome, number> = record.scores.quran.counts;
    const after: Record<QuoteOutcome, number> = copy.records.find((r) => r.turn === record.turn)!.scores!.quran.counts;
    const more = (outcome: QuoteOutcome): number => after[outcome] - before[outcome];
    const failed: number = [...HARD_FAIL].reduce((n: number, outcome) => n + more(outcome), 0);
    const verdict: Verdict = failed > 0 ? 'failed' : more('suspect') > 0 ? 'listed' : 'missed';
    tally[how][verdict]++;
    if (verdict !== 'failed') {
      notFailed.push(
        `${verdict}: ${how} in ${record.model} ${record.questionId} turn ${record.turn + 1}, labelled ${quote.labels.join(', ') || 'nothing'} (${quote.labelScope ?? 'no label'}): ${bad.slice(0, 80)}`,
      );
    }
  }
}

let missed = 0;
for (const how of ['swap', 'drop'] as const) {
  const t = tally[how];
  const total = t.failed + t.listed + t.missed;
  missed += t.missed;
  console.log(`${how} a word: ${total} quotes corrupted, ${t.failed} failed, ${t.listed} listed for reading, ${t.missed} missed`);
}
for (const line of notFailed) console.log(`  ${line}`);
if (missed > 0) process.exit(1);
