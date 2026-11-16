import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { installLogCapture } from '../lib/capture';
import { loadQuestionSet, parseQuestionSet } from '../lib/question-set';
import { costSummary, evaluateGates, modelStats, percentile, renderReport } from '../lib/report';
import { planJobs, runConversation, runJobs, type FacilitatorEvent, type HistoryMessage, type RunnerDeps } from '../lib/runner';
import { costUsd, scoreRun } from '../lib/score';
import type { Question, RunFile, TurnRecord } from '../lib/types';
import {
  VERSES,
  HADITH,
  quranSearch,
  hadithSearch,
  degradedSearch,
  ANSWER_MISQUOTE_68_48,
  ANSWER_CORRECT_52_48,
  ANSWER_WITH_CITATIONS,
} from './fixtures';

/**
 * The harness end to end against a scripted facilitator: two "models", one that searches
 * and quotes correctly and one that reproduces the staging failures. No network.
 */

const USAGE = { promptTokenCount: 10_000, candidatesTokenCount: 800, thoughtsTokenCount: 200, totalTokenCount: 11_000 };

const QUESTIONS: Question[] = [
  {
    id: 'near-in-our-eyes',
    category: 'near-identical',
    language: 'en',
    turns: [
      { text: 'Which verse says "you are in Our eyes"?', expectRefs: ['52:48'] },
      { text: 'Quote it again.', expectRefs: ['52:48'] },
    ],
  },
  { id: 'hadith-patience', category: 'hadith-grade', language: 'en', turns: [{ text: 'A hadith on patience?' }] },
  { id: 'ar-question', category: 'quran-by-topic', language: 'ar', turns: [{ text: 'ما معنى الصبر؟' }] },
];

const ARABIC_ANSWER =
  'الصبر هو حبس النفس على ما تكره ابتغاء وجه الله تعالى، وهو من أعظم الأخلاق التي أمر بها الإسلام وحث عليها في مواضع كثيرة.';
const ENGLISH_ANSWER =
  'Patience means restraining the self for the sake of Allah, and it is one of the greatest virtues that the religion commands in many places.';

interface Call {
  model: string;
  history: HistoryMessage[];
}

function scriptedDeps(): { deps: RunnerDeps; calls: Call[]; lookedUp: string[] } {
  const calls: Call[] = [];
  const lookedUp: string[] = [];
  let clock = 1_000_000;
  const facilitator = async function* (history: HistoryMessage[], model: string): AsyncGenerator<FacilitatorEvent> {
    calls.push({ model, history });
    const question = history[history.length - 1].content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    const provenance = { provider: 'gemini' as const, modelId: model };
    const done = (toolCalls?: FacilitatorEvent['toolCalls']): FacilitatorEvent => ({
      type: 'done',
      data: '',
      usage: USAGE,
      rawPayload: { role: 'model', parts: [{ text: 'final turn' }] },
      toolCalls,
      provenance,
    });
    await Promise.resolve();

    if (model === 'good-model') {
      if (question.includes('in Our eyes')) {
        yield { type: 'tool_use', data: '{"name":"search_quran"}' };
        yield { type: 'text', data: ANSWER_CORRECT_52_48.slice(0, 40) };
        yield { type: 'text', data: ANSWER_CORRECT_52_48.slice(40) };
        yield done(quranSearch(['52:48', '68:48']));
      } else if (question.includes('again')) {
        // No search this turn: the verse comes from the first turn's results.
        yield { type: 'text', data: ANSWER_CORRECT_52_48 };
        yield done();
      } else if (question.includes('hadith')) {
        yield { type: 'text', data: ANSWER_WITH_CITATIONS };
        yield done([...quranSearch(['2:153']), ...hadithSearch([HADITH.patience])]);
      } else {
        yield { type: 'text', data: ARABIC_ANSWER };
        yield done();
      }
      return;
    }

    // bad-model: the staging failures.
    if (question.includes('in Our eyes')) {
      console.warn('[facilitator] empty final completion — retrying', { model });
      yield { type: 'text', data: ANSWER_MISQUOTE_68_48 };
      yield done();
    } else if (question.includes('again')) {
      yield { type: 'error', data: 'Maximum iterations reached', toolCalls: degradedSearch('search_quran'), provenance };
    } else if (question.includes('hadith')) {
      yield { type: 'text', data: ANSWER_WITH_CITATIONS.replace('1_23_42_1302', '9_9_9_9999') };
      yield done([...quranSearch(['2:153']), ...hadithSearch([HADITH.patience])]);
    } else {
      yield { type: 'text', data: ENGLISH_ANSWER };
      yield done();
    }
  };
  return {
    calls,
    lookedUp,
    deps: {
      facilitator,
      lookupVerse: async (key) => {
        lookedUp.push(key);
        return VERSES[key] ? { ar: VERSES[key], en: '' } : null;
      },
      // Every reading advances the clock by 100 ms: timings are exact, not load-dependent.
      now: () => (clock += 100),
    },
  };
}

function runFile(records: TurnRecord[]): RunFile {
  return {
    schemaVersion: 1,
    runId: 'test-run',
    startedAt: '2026-11-15T00:00:00.000Z',
    finishedAt: '2026-11-15T00:10:00.000Z',
    git: { revision: 'a'.repeat(40), dirty: false },
    models: ['good-model', 'bad-model'],
    baseline: 'good-model',
    questionSet: { id: 'test', version: 1, sha256: 'b'.repeat(64), questions: QUESTIONS.length, turns: 4 },
    promptSha256: 'c'.repeat(64),
    options: { repeats: 1, concurrency: 3 },
    prices: {
      'good-model': { inputPerMTok: 1, outputPerMTok: 4 },
      'bad-model': { inputPerMTok: null, outputPerMTok: null },
    },
    records,
  };
}

let run: RunFile;
let script: ReturnType<typeof scriptedDeps>;

beforeAll(async () => {
  installLogCapture();
  script = scriptedDeps();
  const jobs = planJobs(['good-model', 'bad-model'], QUESTIONS, 1);
  // Concurrency 3: requests of both models are in flight together.
  run = runFile(await runJobs(script.deps, jobs, 3));
  scoreRun(run);
});

const record = (model: string, questionId: string, turn = 0) =>
  run.records.find((r) => r.model === model && r.questionId === questionId && r.turn === turn)!;

describe('runner', () => {
  it('records one row per turn per model, in plan order', () => {
    expect(run.records).toHaveLength(8);
    expect(run.records.map((r) => `${r.model}/${r.questionId}/${r.turn}`).slice(0, 4)).toEqual([
      'good-model/near-in-our-eyes/0',
      'good-model/near-in-our-eyes/1',
      'bad-model/near-in-our-eyes/0',
      'bad-model/near-in-our-eyes/1',
    ]);
  });

  it('records the streamed text, timings, usage, provenance and tool calls', () => {
    const r = record('good-model', 'near-in-our-eyes');
    expect(r.outcome).toBe('ok');
    expect(r.answer).toBe(ANSWER_CORRECT_52_48);
    expect(r.usage).toEqual(USAGE);
    expect(r.provenance).toEqual({ provider: 'gemini', modelId: 'good-model' });
    expect(r.toolCalls).toHaveLength(2);
  });

  it('times a turn from its start: first event, first visible text, end', async () => {
    // Its own clock, one conversation: 100 ms per reading, one reading per event and one
    // at the end. Events: tool_use, text, text, done.
    const { deps } = scriptedDeps();
    const [first] = await runConversation(deps, 'good-model', QUESTIONS[0], 0);
    expect(first.timing).toEqual({ firstEventMs: 100, firstTextMs: 200, totalMs: 500 });
    // A turn with no tool call (text, done): the first event is the first text.
    const [plain] = await runConversation(deps, 'good-model', QUESTIONS[2], 0);
    expect(plain.timing).toEqual({ firstEventMs: 100, firstTextMs: 100, totalMs: 300 });
  });

  it('builds turn-2 history the way the chat route does: the answer text with its raw payload', () => {
    const second = script.calls.find((c) => c.model === 'good-model' && c.history.length === 3)!;
    expect(second.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.history[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: ANSWER_CORRECT_52_48 }],
      rawPayload: { role: 'model', parts: [{ text: 'final turn' }] },
    });
  });

  it('looks up only the references no search returned', () => {
    // good-model retrieved 52:48; bad-model named 68:48 with no search.
    expect(script.lookedUp).toEqual(['68:48']);
    expect(record('bad-model', 'near-in-our-eyes').lookups).toEqual({ '68:48': { ar: VERSES['68:48'], en: '' } });
    expect(record('good-model', 'near-in-our-eyes').lookups).toEqual({});
  });

  it('records an error turn with its message and tool calls, and skips nothing silently', () => {
    const r = record('bad-model', 'near-in-our-eyes', 1);
    expect(r.outcome).toBe('error');
    expect(r.error).toBe('Maximum iterations reached');
    expect(r.toolCalls).toHaveLength(2);
    expect(r.usage).toBeNull();
    expect(r.scores).toBeUndefined();
  });

  it('marks the turns after an error as skipped, without asking them', async () => {
    const { deps, calls } = scriptedDeps();
    const failing: RunnerDeps = {
      ...deps,
      facilitator: async function* (history, model) {
        calls.push({ model, history });
        yield { type: 'error', data: 'boom' };
      },
    };
    const question: Question = { id: 'q', category: 'c', language: 'en', turns: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] };
    const records = await runConversation(failing, 'm', question, 0);
    expect(records.map((r) => r.outcome)).toEqual(['error', 'skipped', 'skipped']);
    expect(calls).toHaveLength(1);
  });

  it('records a facilitator that throws as an error turn', async () => {
    const { deps } = scriptedDeps();
    const throwing: RunnerDeps = {
      ...deps,
      facilitator: async function* () {
        throw new Error('Gemini is not configured');
      },
    };
    const [r] = await runConversation(throwing, 'm', QUESTIONS[1], 0);
    expect(r.outcome).toBe('error');
    expect(r.error).toBe('Gemini is not configured');
  });

  it("attributes the facilitator's log lines to the request that wrote them", () => {
    expect(record('bad-model', 'near-in-our-eyes').log).toEqual([
      { level: 'warn', message: '[facilitator] empty final completion — retrying' },
    ]);
    for (const r of run.records.filter((x) => x.model === 'good-model')) expect(r.log).toEqual([]);
  });
});

describe('scoring a run', () => {
  it('scores the good model clean', () => {
    const first = record('good-model', 'near-in-our-eyes').scores!;
    expect(first.quran.counts.exact).toBe(1);
    expect(first.quran.expected).toEqual([{ ref: '52:48', labelled: true, quoted: true }]);
    expect(first.scriptureWithoutSearch.quran).toBe(false);
    expect(first.tools).toMatchObject({ calls: 1, notOk: 0, searchedQuran: true, searchedHadith: false });
    expect(first.costUsd).toBeCloseTo((10_000 * 1 + 1_000 * 4) / 1_000_000, 10);
  });

  it('on the follow-up turn: correct, but quoted with no search in that turn', () => {
    const second = record('good-model', 'near-in-our-eyes', 1).scores!;
    expect(second.quran.quotes[0]).toMatchObject({ outcome: 'exact', grounding: 'earlier_turn' });
    expect(second.quran.notFromThisTurn).toBe(1);
    expect(second.quran.fromMemory).toBe(0);
    expect(second.scriptureWithoutSearch.quran).toBe(true);
  });

  it('scores the bad model: misquote, fabricated id, wrong language, retry', () => {
    const misquote = record('bad-model', 'near-in-our-eyes').scores!;
    expect(misquote.quran.counts.mismatch).toBe(1);
    expect(misquote.quran.fromMemory).toBe(1);
    expect(misquote.scriptureWithoutSearch.quran).toBe(true);
    expect(misquote.events.emptyFinalRetries).toBe(1);
    expect(misquote.costUsd).toBeNull();
    expect(record('bad-model', 'hadith-patience').scores!.hadith.fabricated).toBe(1);
    expect(record('bad-model', 'ar-question').scores!.language).toMatchObject({ inLanguage: false, detected: 'en' });
    expect(record('good-model', 'ar-question').scores!.language.inLanguage).toBe(true);
  });

  it('costUsd is null without usage or without a price, never zero', () => {
    expect(costUsd({ usage: null }, { inputPerMTok: 1, outputPerMTok: 1 })).toBeNull();
    expect(costUsd({ usage: USAGE }, undefined)).toBeNull();
    expect(costUsd({ usage: USAGE }, { inputPerMTok: 1, outputPerMTok: null })).toBeNull();
  });

  it('rescoring is repeatable: the same file scores the same', () => {
    const before = JSON.stringify(run.records.map((r) => r.scores));
    scoreRun(run);
    expect(JSON.stringify(run.records.map((r) => r.scores))).toBe(before);
  });
});

describe('report', () => {
  it('totals each model', () => {
    const good = modelStats('good-model', run.records);
    const bad = modelStats('bad-model', run.records);
    expect(good).toMatchObject({ turns: 4, ok: 4, errors: 0, skipped: 0 });
    expect(bad).toMatchObject({ turns: 4, ok: 3, errors: 1, emptyFinalRetries: 1 });
    expect(good.quran).toMatchObject({ quotes: 3, hardFails: 0, notFromThisTurn: 1, fromMemory: 0 });
    expect(good.quran.byGrounding).toEqual({
      this_turn: { quotes: 2, hardFails: 0 },
      earlier_turn: { quotes: 1, hardFails: 0 },
      none: { quotes: 0, hardFails: 0 },
    });
    expect(bad.quran).toMatchObject({ mismatch: 1, hardFails: 1, fromMemory: 1 });
    expect(bad.quran.byGrounding.none).toEqual({ quotes: 1, hardFails: 1 });
    expect(good.hadith).toMatchObject({ ids: 1, fabricated: 0 });
    expect(bad.hadith).toMatchObject({ ids: 1, fabricated: 1 });
    expect(good.language).toEqual({ scored: 4, inLanguage: 4, arabicQuestions: 1, arabicInLanguage: 1 });
    expect(bad.language).toEqual({ scored: 3, inLanguage: 2, arabicQuestions: 1, arabicInLanguage: 0 });
    expect(good.expected).toEqual({ refs: 2, labelled: 2, quoted: 2 });
    expect(bad.expected).toEqual({ refs: 1, labelled: 0, quoted: 0 });
    expect(good.latency.totalMedian).toBeGreaterThan(0);
    expect(good.latency.firstTextMedian).toBeLessThanOrEqual(good.latency.totalMedian!);
    expect(bad.cost).toEqual({ perAnswerMean: null, total: null, priced: 0 });
  });

  it('fails the bad model on the gates it should fail, and passes a model against itself', () => {
    const good = modelStats('good-model', run.records);
    const bad = modelStats('bad-model', run.records);
    const verdicts = Object.fromEntries(evaluateGates(good, bad).map((g) => [g.gate.slice(0, 2), g.pass]));
    expect(verdicts).toEqual({ G1: false, G2: false, G3: false, G4: true, G5: true, G6: null });
    const self = evaluateGates(good, good).map((g) => g.pass);
    expect(self).toEqual([true, true, true, true, true, true]);
  });

  it('G4 fails at two more failures than the baseline, not at one', () => {
    const good = modelStats('good-model', run.records);
    expect(evaluateGates(good, { ...good, errors: 1 })[3].pass).toBe(true);
    expect(evaluateGates(good, { ...good, errors: 1, budgetSynthesis: 1 })[3].pass).toBe(false);
  });

  it('G5 fails above 1.5 times the baseline, on either measure', () => {
    const good = modelStats('good-model', run.records);
    const latency = (firstTextMedian: number, totalMedian: number) => ({ ...good, latency: { ...good.latency, firstTextMedian, totalMedian } });
    const base = latency(1000, 10_000);
    expect(evaluateGates(base, latency(1500, 15_000))[4].pass).toBe(true);
    expect(evaluateGates(base, latency(1501, 10_000))[4].pass).toBe(false);
    expect(evaluateGates(base, latency(1000, 15_001))[4].pass).toBe(false);
  });

  it('lists every item a human should read', () => {
    const report = renderReport(run);
    expect(report).toContain('## Gates against the baseline');
    expect(report).toContain('| G1 Quran fidelity | FAIL: 1 mismatch or wrong-reference quotes (baseline 0) |');
    // The failed quote, with the word that is wrong.
    expect(report).toMatch(/\| bad-model \| near-in-our-eyes \| mismatch \| 68:48 \|.*بِعَيْنِنَا/);
    expect(report).toContain('| bad-model | hadith-patience | 9_9_9_9999 |');
    expect(report).toContain('| bad-model | ar-question | ar | en |');
    expect(report).toContain('| bad-model | near-in-our-eyes turn 2 | Maximum iterations reached |');
    expect(report).toContain('No price in models.json for `bad-model`');
    // And says None where there is nothing, rather than leaving a section out.
    expect(report).toContain('## Grades that contradict the search result\n\nNone.');
  });

  // Each good-model answer is 10,000 input and 1,000 output tokens at $1 / $4: $0.014.
  it('costs an answer and 1,000 answers, shows the price inputs, and marks an unchecked price', () => {
    const report = renderReport(run);
    expect(report).toContain('| Price, US$ per million tokens: input / output | $1.00 / $4.00 | n/a |');
    expect(report).toContain('| Price confirmed on the Vertex AI pricing page | **NO** | **NO** |');
    // A weaker check is named beside the NO, and is still a NO.
    const partly = renderReport({ ...run, prices: { ...run.prices, 'good-model': { inputPerMTok: 1, outputPerMTok: 4, checked: 'Developer API page, Vertex unconfirmed' } } });
    expect(partly).toContain('| Price confirmed on the Vertex AI pricing page | **NO** (Developer API page, Vertex unconfirmed) | **NO** |');
    expect(partly).toContain('**Prices not confirmed** for `good-model`, `bad-model`.');
    expect(report).toContain('| Tokens per answer: input / output / thinking | 10000 / 800 / 200 | 10000 / 800 / 200 |');
    expect(report).toContain('| Answers costed | 4 of 4 | 0 of 3 |');
    expect(report).toContain('| **Cost per answer** | $0.0140 | n/a |');
    expect(report).toContain('| **Cost per 1,000 answers** | $14.00 | n/a |');
    expect(report).toContain('| … relative to the baseline | 1.00x | n/a |');
    expect(report).toContain('| Cost per answer / per 1,000 answers / this run | $0.0140 / $14.00 / $0.06 (price not confirmed) | n/a / n/a / n/a |');
    expect(report).toContain('**Prices not confirmed** for `good-model`, `bad-model`.');
    // No announced change in these prices: the rows for one are left out.
    expect(report).not.toContain('Announced price change');
  });

  it('a confirmed price reads as confirmed, and an announced change is costed beside the current price', () => {
    const report = renderReport({
      ...run,
      prices: {
        'good-model': { inputPerMTok: 1, outputPerMTok: 4, confirmed: true, source: 'pricing page, read 2026-11-15', next: { from: '2027-01-01', inputPerMTok: 2, outputPerMTok: 8 } },
        // Same tokens, three times the price, no announced change.
        'bad-model': { inputPerMTok: 3, outputPerMTok: 12, confirmed: true, source: 'pricing page, read 2026-11-15' },
      },
    });
    expect(report).toContain('| Price confirmed on the Vertex AI pricing page | yes | yes |');
    expect(report).not.toContain('Prices not confirmed');
    expect(report).not.toContain('(price not confirmed)');
    expect(report).toContain('| Announced price change: input / output | $2.00 / $8.00 from 2027-01-01 | none known |');
    // The run recorded bad-model's scores with no price, so its cost stays n/a until rescored.
    expect(report).toContain('| Cost per 1,000 answers after the announced changes | $28.00 | n/a |');
    expect(report).toContain('- `good-model`: pricing page, read 2026-11-15');
  });

  it('costSummary: the later figure equals the current one without an announced change, and never invents a cost', () => {
    const good = modelStats('good-model', run.records);
    const now = costSummary(good, { inputPerMTok: 1, outputPerMTok: 4 });
    expect(now.perAnswer).toBeCloseTo(0.014, 10);
    expect(now.per1000).toBeCloseTo(14, 8);
    expect(now.laterPer1000).toBeCloseTo(14, 8);
    const later = costSummary(good, { inputPerMTok: 1, outputPerMTok: 4, next: { from: '2027-01-01', inputPerMTok: 2, outputPerMTok: 8 } });
    expect(later.per1000).toBeCloseTo(14, 8);
    expect(later.laterPer1000).toBeCloseTo(28, 8);
    // An unpriced model has no cost now, so it has none later either, even with a `next` price.
    const bad = modelStats('bad-model', run.records);
    expect(costSummary(bad, { inputPerMTok: null, outputPerMTok: null, next: { from: '2027-01-01', inputPerMTok: 2, outputPerMTok: 8 } })).toEqual({
      perAnswer: null,
      per1000: null,
      laterPerAnswer: null,
      laterPer1000: null,
    });
  });

  it('rescoring with a three-times price gives three times the cost per 1,000 answers', () => {
    const copy = structuredClone(run);
    copy.prices['bad-model'] = { inputPerMTok: 3, outputPerMTok: 12 };
    scoreRun(copy);
    const report = renderReport(copy);
    expect(report).toContain('| **Cost per 1,000 answers** | $14.00 | $42.00 |');
    expect(report).toContain('| … relative to the baseline | 1.00x | 3.00x |');
    expect(report).toMatch(/\| G6 Cost \(not gated\) \| FAIL: mean \$0\.0420 per answer, 3\.00x the baseline's \$0\.0140; see Cost \|/);
  });

  it('percentile is nearest-rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });
});

describe('question set v1', () => {
  const { set, sha256 } = loadQuestionSet(path.resolve(__dirname, '../questions/v1.json'));

  it('covers what issue #393 asks for', () => {
    const categories = new Set(set.questions.map((q) => q.category));
    for (const c of ['quran-by-reference', 'quran-by-topic', 'near-identical', 'hadith-grade', 'fiqh', 'follow-up']) {
      expect(categories.has(c), c).toBe(true);
    }
    const languages = new Set(set.questions.map((q) => q.language));
    expect(languages.has('ar')).toBe(true);
    expect([...languages].filter((l) => l !== 'ar' && l !== 'en').length).toBeGreaterThanOrEqual(2);
    // The 52:48 / 68:48 pair, and follow-ups that are really multi-turn.
    const refs = set.questions.flatMap((q) => q.turns.flatMap((t) => t.expectRefs ?? []));
    expect(refs).toContain('52:48');
    expect(refs).toContain('68:48');
    for (const q of set.questions.filter((x) => x.category === 'follow-up')) expect(q.turns.length).toBeGreaterThan(1);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a malformed set fails loudly', () => {
    const base = { id: 's', version: 1, description: '', questions: [{ id: 'a', category: 'c', language: 'en', turns: [{ text: 't' }] }] };
    const withQuestion = (q: object) => JSON.stringify({ ...base, questions: [{ ...base.questions[0], ...q }] });
    expect(() => parseQuestionSet(JSON.stringify(base))).not.toThrow();
    expect(() => parseQuestionSet(withQuestion({ language: 'xx' }))).toThrow(/not valid/);
    expect(() => parseQuestionSet(withQuestion({ turns: [] }))).toThrow(/not valid/);
    expect(() => parseQuestionSet(withQuestion({ turns: [{ text: 't', expectRefs: ['115:1'] }] }))).toThrow(/Quran reference/);
    expect(() => parseQuestionSet(withQuestion({ typo: true }))).toThrow(/not valid/);
    expect(() => parseQuestionSet(JSON.stringify({ ...base, questions: [base.questions[0], base.questions[0]] }))).toThrow(/duplicate/);
  });
});
