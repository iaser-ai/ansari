/**
 * The comparison report: per-model totals, the pre-registered gates against the baseline,
 * and every item a human should read (each failed quote with its diff, each fabricated
 * id, each answer in the wrong language, each error). Counts, not just verdicts.
 */
import { HARD_FAIL, type QuoteScore } from './score-quran';
import type { RunFile, TurnRecord } from './types';

type Grounding = 'this_turn' | 'earlier_turn' | 'none';

export interface ModelStats {
  model: string;
  turns: number;
  ok: number;
  errors: number;
  skipped: number;
  budgetSynthesis: number;
  emptyFinalRetries: number;
  transientRetries: number;
  quran: {
    quotes: number;
    exact: number;
    standard: number;
    skeleton: number;
    wrongReference: number;
    mismatch: number;
    suspect: number;
    unlabelled: number;
    unverifiable: number;
    hardFails: number;
    notFromThisTurn: number;
    fromMemory: number;
    byGrounding: Record<Grounding, { quotes: number; hardFails: number }>;
    followUp: { quotes: number; notFromThisTurn: number };
  };
  expected: { refs: number; labelled: number; quoted: number };
  hadith: {
    ids: number;
    thisTurn: number;
    earlierTurn: number;
    fabricated: number;
    entriesWithoutLkId: number;
    gradeMatches: number;
    gradeContradicts: number;
    gradeNotStated: number;
  };
  language: { scored: number; inLanguage: number; arabicQuestions: number; arabicInLanguage: number };
  scriptureWithoutSearch: { quran: number; hadith: number };
  latency: { firstTextMedian: number | null; firstTextP90: number | null; totalMedian: number | null; totalP90: number | null };
  tokens: { promptMean: number | null; outputMean: number | null; thoughtsMean: number | null };
  cost: { perAnswerMean: number | null; total: number | null; priced: number };
  tools: { callsMean: number | null; notOk: number };
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

export function modelStats(model: string, records: TurnRecord[]): ModelStats {
  const mine = records.filter((r) => r.model === model);
  const scored = mine.filter((r) => r.outcome === 'ok' && r.scores);
  const sum = (pick: (r: TurnRecord) => number) => scored.reduce((total, r) => total + pick(r), 0);
  const quotes = scored.flatMap((r) => r.scores!.quran.quotes.map((q) => ({ q, r })));
  const quran = quotes.filter(({ q }) => q.grounding !== null && isQuranQuote(q));
  const byGrounding: ModelStats['quran']['byGrounding'] = {
    this_turn: { quotes: 0, hardFails: 0 },
    earlier_turn: { quotes: 0, hardFails: 0 },
    none: { quotes: 0, hardFails: 0 },
  };
  for (const { q } of quran) {
    const bucket = byGrounding[q.grounding as Grounding];
    bucket.quotes++;
    if (HARD_FAIL.has(q.outcome)) bucket.hardFails++;
  }
  const followUps = scored.filter((r) => r.turn > 0);
  const costs = scored.map((r) => r.scores!.costUsd).filter((c): c is number => c !== null);
  const withUsage = scored.filter((r) => r.usage);
  const arabic = scored.filter((r) => r.language === 'ar');

  return {
    model,
    turns: mine.length,
    ok: mine.filter((r) => r.outcome === 'ok').length,
    errors: mine.filter((r) => r.outcome === 'error').length,
    skipped: mine.filter((r) => r.outcome === 'skipped').length,
    budgetSynthesis: scored.filter((r) => r.scores!.events.budgetSynthesis).length,
    emptyFinalRetries: mine.reduce((t, r) => t + r.log.filter((l) => l.message.includes('empty final completion — retrying')).length, 0),
    transientRetries: mine.reduce((t, r) => t + r.log.filter((l) => l.message.includes('transient error')).length, 0),
    quran: {
      quotes: sum((r) => r.scores!.quran.quranQuotes),
      exact: sum((r) => r.scores!.quran.counts.exact),
      standard: sum((r) => r.scores!.quran.counts.standard),
      skeleton: sum((r) => r.scores!.quran.counts.skeleton),
      wrongReference: sum((r) => r.scores!.quran.counts.wrong_reference),
      mismatch: sum((r) => r.scores!.quran.counts.mismatch),
      suspect: sum((r) => r.scores!.quran.counts.suspect),
      unlabelled: sum((r) => r.scores!.quran.counts.unlabelled),
      unverifiable: sum((r) => r.scores!.quran.counts.unverifiable),
      hardFails: sum((r) => r.scores!.quran.counts.wrong_reference + r.scores!.quran.counts.mismatch),
      notFromThisTurn: sum((r) => r.scores!.quran.notFromThisTurn),
      fromMemory: sum((r) => r.scores!.quran.fromMemory),
      byGrounding,
      followUp: {
        quotes: followUps.reduce((t, r) => t + r.scores!.quran.quranQuotes, 0),
        notFromThisTurn: followUps.reduce((t, r) => t + r.scores!.quran.notFromThisTurn, 0),
      },
    },
    expected: {
      refs: sum((r) => r.scores!.quran.expected.length),
      labelled: sum((r) => r.scores!.quran.expected.filter((e) => e.labelled).length),
      quoted: sum((r) => r.scores!.quran.expected.filter((e) => e.quoted).length),
    },
    hadith: {
      ids: sum((r) => r.scores!.hadith.total),
      thisTurn: sum((r) => r.scores!.hadith.thisTurn),
      earlierTurn: sum((r) => r.scores!.hadith.earlierTurn),
      fabricated: sum((r) => r.scores!.hadith.fabricated),
      entriesWithoutLkId: sum((r) => r.scores!.hadith.entriesWithoutLkId.length),
      gradeMatches: sum((r) => r.scores!.hadith.grades.matches),
      gradeContradicts: sum((r) => r.scores!.hadith.grades.contradicts),
      gradeNotStated: sum((r) => r.scores!.hadith.grades.not_stated),
    },
    language: {
      scored: scored.length,
      inLanguage: scored.filter((r) => r.scores!.language.inLanguage).length,
      arabicQuestions: arabic.length,
      arabicInLanguage: arabic.filter((r) => r.scores!.language.inLanguage).length,
    },
    scriptureWithoutSearch: {
      quran: scored.filter((r) => r.scores!.scriptureWithoutSearch.quran).length,
      hadith: scored.filter((r) => r.scores!.scriptureWithoutSearch.hadith).length,
    },
    latency: {
      firstTextMedian: percentile(scored.flatMap((r) => (r.timing.firstTextMs === null ? [] : [r.timing.firstTextMs])), 50),
      firstTextP90: percentile(scored.flatMap((r) => (r.timing.firstTextMs === null ? [] : [r.timing.firstTextMs])), 90),
      totalMedian: percentile(scored.map((r) => r.timing.totalMs), 50),
      totalP90: percentile(scored.map((r) => r.timing.totalMs), 90),
    },
    tokens: {
      promptMean: mean(withUsage.map((r) => r.usage!.promptTokenCount)),
      outputMean: mean(withUsage.map((r) => r.usage!.candidatesTokenCount)),
      thoughtsMean: mean(withUsage.map((r) => r.usage!.thoughtsTokenCount)),
    },
    cost: { perAnswerMean: mean(costs), total: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0), priced: costs.length },
    tools: { callsMean: mean(scored.map((r) => r.scores!.tools.calls)), notOk: sum((r) => r.scores!.tools.notOk) },
  };
}

function isQuranQuote(q: QuoteScore): boolean {
  return ['exact', 'standard', 'skeleton', 'wrong_reference', 'mismatch', 'unlabelled'].includes(q.outcome);
}

export interface GateResult {
  gate: string;
  pass: boolean | null;
  detail: string;
}

const share = (n: number, of: number): number => (of === 0 ? 1 : n / of);
const pct = (n: number, of: number): string => (of === 0 ? 'n/a' : `${Math.round((100 * n) / of)}%`);

/**
 * The gates written into the experiment notes before the run (codev/experiments/393-*).
 * Changing a threshold here after seeing results would defeat them.
 */
export function evaluateGates(base: ModelStats, cand: ModelStats): GateResult[] {
  const reliability = (s: ModelStats) => s.errors + s.budgetSynthesis;
  const within = (c: number | null, b: number | null) => (c === null || b === null ? null : c <= 1.5 * b);
  const first = within(cand.latency.firstTextMedian, base.latency.firstTextMedian);
  const total = within(cand.latency.totalMedian, base.latency.totalMedian);
  const cost =
    cand.cost.perAnswerMean === null || base.cost.perAnswerMean === null
      ? null
      : cand.cost.perAnswerMean <= 2 * base.cost.perAnswerMean;
  return [
    {
      gate: 'G1 Quran fidelity',
      pass: cand.quran.hardFails <= base.quran.hardFails,
      detail: `${cand.quran.hardFails} mismatch or wrong-reference quotes (baseline ${base.quran.hardFails})`,
    },
    { gate: 'G2 Hadith ids', pass: cand.hadith.fabricated === 0, detail: `${cand.hadith.fabricated} fabricated LK ids` },
    {
      gate: 'G3 Language',
      pass:
        share(cand.language.inLanguage, cand.language.scored) >= share(base.language.inLanguage, base.language.scored) &&
        cand.language.arabicInLanguage === cand.language.arabicQuestions,
      detail: `${cand.language.inLanguage}/${cand.language.scored} in the question's language (baseline ${base.language.inLanguage}/${base.language.scored}); Arabic ${cand.language.arabicInLanguage}/${cand.language.arabicQuestions}`,
    },
    {
      gate: 'G4 Reliability',
      pass: reliability(cand) <= reliability(base) + 1,
      detail: `${cand.errors} errors + ${cand.budgetSynthesis} budget syntheses (baseline ${base.errors} + ${base.budgetSynthesis})`,
    },
    {
      gate: 'G5 Latency',
      pass: first === null || total === null ? null : first && total,
      detail: `median first text ${ms(cand.latency.firstTextMedian)} (baseline ${ms(base.latency.firstTextMedian)}), median total ${ms(cand.latency.totalMedian)} (baseline ${ms(base.latency.totalMedian)})`,
    },
    {
      gate: 'G6 Cost (not gated)',
      pass: cost,
      detail: `mean ${usd(cand.cost.perAnswerMean)} per answer (baseline ${usd(base.cost.perAnswerMean)})`,
    },
  ];
}

const ms = (value: number | null): string => (value === null ? 'n/a' : `${(value / 1000).toFixed(1)}s`);
const usd = (value: number | null): string => (value === null ? 'n/a' : `$${value.toFixed(4)}`);
const num = (value: number | null, digits = 0): string => (value === null ? 'n/a' : value.toFixed(digits));
const verdict = (pass: boolean | null): string => (pass === null ? 'n/a' : pass ? 'pass' : 'FAIL');

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const clip = (text: string, max = 160): string => (text.length <= max ? text : `${text.slice(0, max)}…`);
const where = (r: TurnRecord): string => `${r.questionId}${r.turn > 0 ? ` turn ${r.turn + 1}` : ''}${r.repeat > 0 ? ` (repeat ${r.repeat + 1})` : ''}`;

export function renderReport(run: RunFile): string {
  const stats = run.models.map((m) => modelStats(m, run.records));
  const base = stats.find((s) => s.model === run.baseline) ?? stats[0];
  const out: string[] = [];

  out.push(`# Model comparison ${run.runId}`, '');
  out.push(
    `- Run: ${run.startedAt} to ${run.finishedAt}, git \`${run.git.revision.slice(0, 12)}\`${run.git.dirty ? ' (uncommitted changes)' : ''}`,
    `- Question set: \`${run.questionSet.id}\` v${run.questionSet.version}, ${run.questionSet.questions} questions, ${run.questionSet.turns} turns, sha256 \`${run.questionSet.sha256.slice(0, 12)}\``,
    `- Models: ${run.models.map((m) => `\`${m}\``).join(', ')}; baseline \`${base.model}\`; ${run.options.repeats} sample(s) per question`,
    `- Facilitator prompt sha256 \`${run.promptSha256.slice(0, 12)}\``,
    '',
  );

  const candidates = stats.filter((s) => s.model !== base.model);
  if (candidates.length > 0) {
    const gates = candidates.map((c) => evaluateGates(base, c));
    out.push('## Gates against the baseline', '');
    out.push(
      table(
        ['Gate', ...candidates.map((c) => c.model)],
        gates[0].map((g, i) => [g.gate, ...gates.map((list) => `${verdict(list[i].pass)}: ${list[i].detail}`)]),
      ),
      '',
    );
  }

  const row = (label: string, pick: (s: ModelStats) => string): string[] => [label, ...stats.map(pick)];
  out.push('## Comparison', '');
  out.push(
    table(
      ['Measure', ...stats.map((s) => s.model)],
      [
        row('Turns answered / asked', (s) => `${s.ok} / ${s.turns}`),
        row('Errors (and turns skipped after one)', (s) => `${s.errors} (${s.skipped})`),
        row('Budget syntheses', (s) => `${s.budgetSynthesis}`),
        row('Empty-final retries / transient retries', (s) => `${s.emptyFinalRetries} / ${s.transientRetries}`),
        row('Quran quotes', (s) => `${s.quran.quotes}`),
        row('… exact', (s) => `${s.quran.exact}`),
        row('… correct in standard spelling', (s) => `${s.quran.standard}`),
        row('… alef-only difference (read these)', (s) => `${s.quran.skeleton}`),
        row('… **mismatch**', (s) => `${s.quran.mismatch}`),
        row('… **wrong reference**', (s) => `${s.quran.wrongReference}`),
        row('… no reference near the quote', (s) => `${s.quran.unlabelled}`),
        row('Suspect Arabic near a reference (read these)', (s) => `${s.quran.suspect}`),
        row('Quotes with no source text to check', (s) => `${s.quran.unverifiable}`),
        row('Quran quotes not from a search in the same turn', (s) => `${s.quran.notFromThisTurn} (${pct(s.quran.notFromThisTurn, s.quran.quotes)})`),
        row('… of which no search ever returned the verse', (s) => `${s.quran.fromMemory}`),
        row('Turns quoting Quran with no search_quran result', (s) => `${s.scriptureWithoutSearch.quran}`),
        row('Expected references named / quoted correctly', (s) => `${s.expected.labelled} / ${s.expected.quoted} of ${s.expected.refs}`),
        row('LK ids cited', (s) => `${s.hadith.ids}`),
        row('… from this turn / an earlier turn', (s) => `${s.hadith.thisTurn} / ${s.hadith.earlierTurn}`),
        row('… **fabricated**', (s) => `${s.hadith.fabricated}`),
        row('Hadith citations with no LK id', (s) => `${s.hadith.entriesWithoutLkId}`),
        row('Grade stated: agrees / contradicts / not stated', (s) => `${s.hadith.gradeMatches} / ${s.hadith.gradeContradicts} / ${s.hadith.gradeNotStated}`),
        row('Turns citing hadith with no search_hadith result', (s) => `${s.scriptureWithoutSearch.hadith}`),
        row("Answers in the question's language", (s) => `${s.language.inLanguage} / ${s.language.scored}`),
        row('… Arabic questions', (s) => `${s.language.arabicInLanguage} / ${s.language.arabicQuestions}`),
        row('Time to first text: median / p90', (s) => `${ms(s.latency.firstTextMedian)} / ${ms(s.latency.firstTextP90)}`),
        row('Total time: median / p90', (s) => `${ms(s.latency.totalMedian)} / ${ms(s.latency.totalP90)}`),
        row('Tool calls per answer (calls that returned no source)', (s) => `${num(s.tools.callsMean, 1)} (${s.tools.notOk})`),
        row('Tokens per answer: input / output / thinking', (s) => `${num(s.tokens.promptMean)} / ${num(s.tokens.outputMean)} / ${num(s.tokens.thoughtsMean)}`),
        row('Cost per answer / whole run', (s) => `${usd(s.cost.perAnswerMean)} / ${usd(s.cost.total)}`),
      ],
    ),
    '',
  );

  out.push('## Quran quotes by where the verse came from', '');
  out.push(
    table(
      ['Source of the verse', ...stats.map((s) => `${s.model}: quotes (failed)`)],
      (['this_turn', 'earlier_turn', 'none'] as const).map((g) => [
        { this_turn: 'A search in the same turn', earlier_turn: 'A search in an earlier turn', none: 'No search (written from memory)' }[g],
        ...stats.map((s) => `${s.quran.byGrounding[g].quotes} (${s.quran.byGrounding[g].hardFails})`),
      ]),
    ),
    '',
    `On follow-up turns: ${stats.map((s) => `${s.model} ${s.quran.followUp.notFromThisTurn} of ${s.quran.followUp.quotes} quotes not from a same-turn search`).join('; ')}.`,
    '',
  );

  const categories = [...new Set(run.records.map((r) => r.category))];
  out.push('## By category', '', 'Each cell: failed Quran quotes / Quran quotes · fabricated LK ids / LK ids · answers in language / answered · errors.', '');
  out.push(
    table(
      ['Category', ...stats.map((s) => s.model)],
      categories.map((category) => [
        category,
        ...run.models.map((model) => {
          const s = modelStats(model, run.records.filter((r) => r.category === category));
          return `${s.quran.hardFails}/${s.quran.quotes} · ${s.hadith.fabricated}/${s.hadith.ids} · ${s.language.inLanguage}/${s.language.scored} · ${s.errors}`;
        }),
      ]),
    ),
    '',
  );

  const languages = [...new Set(run.records.map((r) => r.language))];
  out.push('## By question language', '', 'Each cell: answers in the question\'s language / answered · failed Quran quotes / Quran quotes.', '');
  out.push(
    table(
      ['Language', ...stats.map((s) => s.model)],
      languages.map((language) => [
        language,
        ...run.models.map((model) => {
          const s = modelStats(model, run.records.filter((r) => r.language === language));
          return `${s.language.inLanguage}/${s.language.scored} · ${s.quran.hardFails}/${s.quran.quotes}`;
        }),
      ]),
    ),
    '',
  );

  // Every item a human should read.
  const answered = run.records.filter((r) => r.outcome === 'ok' && r.scores);
  const quoteRows = (outcomes: string[]): string[][] =>
    answered.flatMap((r) =>
      r.scores!.quran.quotes
        .filter((q) => outcomes.includes(q.outcome))
        .map((q) => [
          r.model,
          where(r),
          q.outcome,
          q.labels.join(', ') || 'none',
          cell(clip(q.text)),
          q.diff
            ? cell(`vs ${q.diff.against}: wrote [${q.diff.extra.join(' ')}] for [${q.diff.missing.join(' ')}]`)
            : q.matched.length > 0
              ? `text is ${q.matched.join(', ')}`
              : '',
          q.grounding ?? '',
        ]),
    );
  const listing = (title: string, header: string[], rows: string[][]) => {
    out.push(`## ${title}`, '', rows.length === 0 ? 'None.' : table(header, rows), '');
  };
  const quoteHeader = ['Model', 'Question', 'Outcome', 'Labelled', 'Quoted text', 'Difference (standard spelling)', 'Verse source'];
  listing('Failed Quran quotes', quoteHeader, quoteRows(['mismatch', 'wrong_reference']));
  listing('Quotes to read: alef-only differences and suspect Arabic', quoteHeader, quoteRows(['skeleton', 'suspect']));
  listing(
    'Fabricated LK ids',
    ['Model', 'Question', 'LK id'],
    answered.flatMap((r) => r.scores!.hadith.lkIds.filter((l) => l.status === 'fabricated').map((l) => [r.model, where(r), l.id])),
  );
  listing(
    'Grades that contradict the search result',
    ['Model', 'Question', 'LK id', 'Search result', 'Answer states'],
    answered.flatMap((r) =>
      r.scores!.hadith.lkIds
        .filter((l) => l.grade === 'contradicts')
        .map((l) => [r.model, where(r), l.id, cell(l.sourceGrade ?? ''), (l.stated ?? []).join(', ')]),
    ),
  );
  listing(
    'Hadith citations with no LK id',
    ['Model', 'Question', 'Citation'],
    answered.flatMap((r) => r.scores!.hadith.entriesWithoutLkId.map((e) => [r.model, where(r), cell(clip(e))])),
  );
  listing(
    "Answers not in the question's language",
    ['Model', 'Question', 'Expected', 'Read as', 'Arabic-script share', 'Opening'],
    answered
      .filter((r) => !r.scores!.language.inLanguage)
      .map((r) => [r.model, where(r), r.language, r.scores!.language.detected, r.scores!.language.arabicShare.toFixed(2), cell(clip(r.answer, 100))]),
  );
  listing(
    'Errors',
    ['Model', 'Question', 'Error', 'Seconds'],
    run.records.filter((r) => r.outcome === 'error').map((r) => [r.model, where(r), cell(clip(r.error ?? '', 200)), (r.timing.totalMs / 1000).toFixed(1)]),
  );

  const unpriced = run.models.filter((m) => {
    const p = run.prices[m];
    return !p || p.inputPerMTok === null || p.outputPerMTok === null;
  });
  out.push('## What this report does not show', '');
  out.push(
    `- One run of ${run.options.repeats} sample(s) per question. Zero failures in n answers bounds the true rate below about 3/n, no lower.`,
    '- A Quran quote with no reference near it and no matching verse in hand is not scored. In an answer written in Arabic script, only quoted or vowelled Arabic is read as a quote.',
    '- An errored turn reports no token usage, so its cost is not in the totals.',
    ...(unpriced.length > 0 ? [`- No price in models.json for ${unpriced.map((m) => `\`${m}\``).join(', ')}: cost is n/a for those.`] : []),
    '',
  );
  return out.join('\n');
}
