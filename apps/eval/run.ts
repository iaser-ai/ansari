/**
 * Model evaluation harness (issue #393): run a question set through the real facilitator
 * for each model, score every answer, write a results file and a comparison report.
 *
 *   pnpm --filter ansari-eval exec -- tsx --env-file=<env file> run.ts \
 *     --models gemini-3.7-flash,gemini-4-hydrogen,gemini-4-argon
 *
 * See README.md.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installLogCapture } from './lib/capture';
import { loadQuestionSet } from './lib/question-set';
import { renderReport } from './lib/report';
import { planJobs, runJobs, type RunnerDeps } from './lib/runner';
import { scoreRun } from './lib/score';
import type { ModelPrice, Question, RunFile, TurnRecord } from './lib/types';

const EVAL_DIR = __dirname;
/** Conversations that must all fail, with none answered, before the run gives up. */
const ABORT_AFTER = 4;

interface Args {
  models: string[];
  questions: string;
  out: string;
  repeats: number;
  concurrency: number;
  only: string[];
  dryRun: boolean;
  verbose: boolean;
}

const USAGE = `usage: tsx run.ts --models <id,id,...> [options]

  --models <ids>        Comma-separated model ids. The first is the baseline.
  --questions <file>    Question set (default: questions/v1.json).
  --out <dir>           Where the results file and report go (default: results).
  --repeats <n>         Samples per question per model (default: 1).
  --concurrency <n>     Conversations in flight at once (default: 4).
  --only <ids>          Only these question ids or category:<name>, comma-separated.
  --dry-run             Print the plan and the call estimate; call nothing.
  --verbose             Also print the facilitator's own warnings as they happen.`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    models: [],
    questions: path.join(EVAL_DIR, 'questions/v1.json'),
    out: path.join(EVAL_DIR, 'results'),
    repeats: 1,
    concurrency: 4,
    only: [],
    dryRun: false,
    verbose: false,
  };
  const list = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);
  const positive = (name: string, value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer, got "${value}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--verbose') args.verbose = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      const value = argv[++i];
      if (value === undefined) fail(`${flag} needs a value`);
      if (flag === '--models') args.models = list(value);
      else if (flag === '--questions') args.questions = path.resolve(value);
      else if (flag === '--out') args.out = path.resolve(value);
      else if (flag === '--repeats') args.repeats = positive(flag, value);
      else if (flag === '--concurrency') args.concurrency = positive(flag, value);
      else if (flag === '--only') args.only = list(value);
      else fail(`unknown option ${flag}`);
    }
  }
  if (args.models.length === 0) fail('--models is required');
  if (new Set(args.models).size !== args.models.length) fail('--models lists a model twice');
  return args;
}

function selectQuestions(all: Question[], only: string[]): Question[] {
  if (only.length === 0) return all;
  const selected = all.filter((q) => only.includes(q.id) || only.includes(`category:${q.category}`));
  // A filter that matches nothing must not pass as an empty, green run.
  for (const wanted of only) {
    const hit = all.some((q) => q.id === wanted || `category:${q.category}` === wanted);
    if (!hit) fail(`--only "${wanted}" matches no question`);
  }
  return selected;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: EVAL_DIR, encoding: 'utf8' }).trim();
}

function loadPrices(models: string[]): Record<string, ModelPrice> {
  const file = JSON.parse(readFileSync(path.join(EVAL_DIR, 'models.json'), 'utf8')) as {
    models: Record<string, ModelPrice>;
  };
  return Object.fromEntries(
    models.map((m) => [m, file.models[m] ?? { inputPerMTok: null, outputPerMTok: null, source: 'not in models.json' }]),
  );
}

/** The real facilitator and the real Quran lookup. Imported here so --dry-run needs no credentials. */
async function realDeps(): Promise<{ deps: RunnerDeps; promptSha256: string }> {
  const { config } = await import('@/lib/config');
  // Touch the settings the run depends on now, so a missing credential fails before the
  // first question rather than as forty error rows.
  void config.gemini;
  void config.tools;
  const { runFacilitator } = await import('@/lib/facilitator/agent');
  const { SearchQuran } = await import('@/lib/tools/search-quran');
  const { FACILITATOR_SYSTEM_PROMPT } = await import('@/lib/ai/prompts/facilitator');

  const search = new SearchQuran();
  const cache = new Map<string, Promise<{ ar: string; en: string } | null>>();
  const lookupVerse = (key: string) => {
    let pending = cache.get(key);
    if (!pending) {
      pending = search.run(key).then((result) => {
        const doc = result.documents.find((d) => d.title === `Quran ${key}`);
        if (!doc) return null;
        const body = JSON.parse(doc.source.data) as { ar?: string; en?: string };
        return body.ar ? { ar: body.ar, en: body.en ?? '' } : null;
      });
      cache.set(key, pending);
    }
    return pending;
  };

  return {
    deps: {
      facilitator: (history, model) => runFacilitator(history, undefined, { model }),
      lookupVerse,
    },
    promptSha256: createHash('sha256').update(FACILITATOR_SYSTEM_PROMPT).digest('hex'),
  };
}

function summarize(records: TurnRecord[]): string {
  const last = records[records.length - 1];
  const errors = records.filter((r) => r.outcome === 'error').length;
  const seconds = records.reduce((t, r) => t + r.timing.totalMs, 0) / 1000;
  return `${last.model} ${last.questionId}: ${errors > 0 ? `ERROR ${records.find((r) => r.error)?.error?.slice(0, 80)}` : 'ok'} (${seconds.toFixed(0)}s)`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { set, sha256 } = loadQuestionSet(args.questions);
  const questions = selectQuestions(set.questions, args.only);
  const turns = questions.reduce((t, q) => t + q.turns.length, 0);
  const jobs = planJobs(args.models, questions, args.repeats);
  const requests = turns * args.models.length * args.repeats;

  console.log(`Question set ${set.id} v${set.version}: ${questions.length} questions, ${turns} turns.`);
  console.log(`Models: ${args.models.join(', ')} (baseline ${args.models[0]}); ${args.repeats} sample(s) each.`);
  // Each request is 1 model call with no search, typically 2 to 4 with searches, and at
  // most 11 (10 tool rounds + the answer) before the facilitator's own caps stop it.
  console.log(
    `Plan: ${jobs.length} conversations, ${requests} facilitator requests, about ${requests * 2} to ${requests * 4} model calls (hard ceiling ${requests * 11}).`,
  );
  if (args.dryRun) {
    for (const q of questions) console.log(`  ${q.id} [${q.category}, ${q.language}] ${q.turns.length} turn(s)`);
    return;
  }

  const { deps, promptSha256 } = await realDeps();
  installLogCapture({ echo: args.verbose });

  const startedAt = new Date();
  const revision = git('rev-parse', 'HEAD');
  const runId = `${startedAt.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${revision.slice(0, 8)}`;
  const run: RunFile = {
    schemaVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    git: { revision, dirty: git('status', '--porcelain', '--untracked-files=no') !== '' },
    models: args.models,
    baseline: args.models[0],
    questionSet: { id: set.id, version: set.version, sha256, questions: questions.length, turns },
    promptSha256,
    options: { repeats: args.repeats, concurrency: args.concurrency, ...(args.only.length > 0 ? { only: args.only } : {}) },
    prices: loadPrices(args.models),
    records: [],
  };

  mkdirSync(args.out, { recursive: true });
  const resultsPath = path.join(args.out, `${runId}.json`);
  const save = () => writeFileSync(resultsPath, `${JSON.stringify(run, null, 1)}\n`);

  // Saved after every conversation: a run that dies part-way keeps what it paid for.
  await runJobs(deps, jobs, args.concurrency, (_job, records, done) => {
    run.records.push(...records);
    save();
    console.log(`[${done}/${jobs.length}] ${summarize(records)}`);
    // Nothing has answered yet and several conversations have failed: a credential, a
    // model id or the network is wrong. Stop rather than write a file of errors.
    if (done >= ABORT_AFTER && run.records.every((r) => r.outcome !== 'ok')) {
      throw new Error(
        `The first ${done} conversations all failed; stopping. Last error: ${run.records.find((r) => r.error)?.error ?? 'none recorded'}\nPartial results: ${resultsPath}`,
      );
    }
  });

  run.finishedAt = new Date().toISOString();
  scoreRun(run);
  save();
  const reportPath = path.join(args.out, `${runId}.md`);
  writeFileSync(reportPath, renderReport(run));
  console.log(`\nResults: ${resultsPath}\nReport:  ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
