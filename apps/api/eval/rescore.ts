/**
 * Score a results file again and rewrite its report, without calling any model.
 *
 *   pnpm --filter ansari-api exec -- tsx eval/rescore.ts <results.json>
 *
 * For a corrected scorer, or prices added to models.json after the run. The raw answers,
 * tool-call records and looked-up verses in the file are untouched; only `scores`,
 * `prices` and the report change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderReport } from './lib/report';
import { scoreRun } from './lib/score';
import type { ModelPrice, RunFile } from './lib/types';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx eval/rescore.ts <results.json>');
  process.exit(2);
}

const resultsPath = path.resolve(file);
const run = JSON.parse(readFileSync(resultsPath, 'utf8')) as RunFile;
if (run.schemaVersion !== 1) {
  console.error(`${resultsPath}: schemaVersion ${String(run.schemaVersion)} is not one this harness reads (1)`);
  process.exit(1);
}

// A price that was unknown at run time may be known now.
const prices = JSON.parse(readFileSync(path.join(__dirname, 'models.json'), 'utf8')) as {
  models: Record<string, ModelPrice>;
};
for (const model of run.models) {
  const current = prices.models[model];
  if (current && current.inputPerMTok !== null && current.outputPerMTok !== null) run.prices[model] = current;
}

scoreRun(run);
writeFileSync(resultsPath, `${JSON.stringify(run, null, 1)}\n`);
const reportPath = resultsPath.replace(/\.json$/, '.md');
writeFileSync(reportPath, renderReport(run));
console.log(`Rescored ${run.records.filter((r) => r.scores).length} of ${run.records.length} turns.\nReport: ${reportPath}`);
