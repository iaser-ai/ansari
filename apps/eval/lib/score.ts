/**
 * Scoring one turn: everything the comparison measures, computed from what the run
 * recorded (the answer, the tool-call records, the log lines, the looked-up verses).
 *
 * Pure: no network, no clock. `rescore` runs it again over a results file, so a scorer
 * can be corrected without paying for the model calls twice.
 */
import { scoreHadith } from './score-hadith';
import { scoreLanguage } from './score-language';
import { scoreQuran } from './score-quran';
import { turnSources, type RetrievedHadith, type RetrievedVerse } from './sources';
import type { LogEvent, ModelPrice, RequestEvents, RunFile, TurnRecord, TurnScores } from './types';

export function requestEvents(log: LogEvent[]): RequestEvents {
  const count = (needle: string) => log.filter((l) => l.message.includes(needle)).length;
  return {
    emptyFinalRetries: count('empty final completion — retrying'),
    transientRetries: count('transient error'),
    repetitionCuts: count('repetition loop detected'),
    budgetSynthesis: count('request-budget short-circuit') > 0,
  };
}

/** Input at the input price; visible output and thinking at the output price. */
export function costUsd(record: Pick<TurnRecord, 'usage'>, price: ModelPrice | undefined): number | null {
  if (!record.usage || !price || price.inputPerMTok === null || price.outputPerMTok === null) return null;
  const { promptTokenCount, candidatesTokenCount, thoughtsTokenCount } = record.usage;
  return (
    (promptTokenCount * price.inputPerMTok + (candidatesTokenCount + thoughtsTokenCount) * price.outputPerMTok) /
    1_000_000
  );
}

export interface EarlierTurns {
  verses: RetrievedVerse[];
  hadith: RetrievedHadith[];
  otherTexts: string[];
}

export function scoreTurn(record: TurnRecord, earlier: EarlierTurns, price: ModelPrice | undefined): TurnScores {
  const sources = turnSources(record.toolCalls);
  const quran = scoreQuran({
    answer: record.answer,
    thisTurn: sources.verses,
    earlierTurns: earlier.verses,
    lookups: record.lookups,
    hadith: [...sources.hadith, ...earlier.hadith],
    otherTexts: sources.otherTexts,
    earlierOtherTexts: earlier.otherTexts,
    expectRefs: record.expectRefs,
  });
  const hadith = scoreHadith({ answer: record.answer, thisTurn: sources.hadith, earlierTurns: earlier.hadith });
  const byName: Record<string, number> = {};
  for (const call of sources.calls) byName[call.name] = (byName[call.name] ?? 0) + 1;
  const returned = (name: string) => sources.calls.some((c) => c.name === name && c.status === 'ok');
  const searchedQuran = returned('search_quran');
  const searchedHadith = returned('search_hadith');
  return {
    quran,
    hadith,
    language: scoreLanguage(record.answer, record.language),
    tools: {
      calls: sources.calls.length,
      byName,
      notOk: sources.calls.filter((c) => c.status !== 'ok').length,
      searchedQuran,
      searchedHadith,
    },
    scriptureWithoutSearch: {
      quran: quran.quranQuotes > 0 && !searchedQuran,
      hadith: hadith.total > 0 && !searchedHadith,
    },
    events: requestEvents(record.log),
    costUsd: costUsd(record, price),
  };
}

function conversationKey(r: TurnRecord): string {
  return `${r.model}\u0000${r.questionId}\u0000${r.repeat}`;
}

/**
 * Score every answered turn of a run, in place. A turn is scored against its own search
 * results and those of the earlier turns of the same conversation.
 */
export function scoreRun(run: RunFile): void {
  const conversations = new Map<string, TurnRecord[]>();
  for (const record of run.records) {
    const key = conversationKey(record);
    conversations.set(key, [...(conversations.get(key) ?? []), record]);
  }
  for (const turns of conversations.values()) {
    turns.sort((a, b) => a.turn - b.turn);
    const earlier: EarlierTurns = { verses: [], hadith: [], otherTexts: [] };
    for (const record of turns) {
      if (record.outcome === 'ok') record.scores = scoreTurn(record, earlier, run.prices[record.model]);
      else delete record.scores;
      const sources = turnSources(record.toolCalls);
      earlier.verses.push(...sources.verses);
      earlier.hadith.push(...sources.hadith);
      earlier.otherTexts.push(...sources.otherTexts);
    }
  }
}
