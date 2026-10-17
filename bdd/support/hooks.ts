import { After, AfterAll, Before, setDefaultTimeout } from '@cucumber/cucumber';
import { closeDb } from './api.ts';
import { fakeGemini } from './fake-gemini.ts';
import { addOutcome, writeReport } from './report.ts';
import { stopAllServers } from './servers.ts';
import type { ImageWorld } from './world.ts';

// Real model answers with tool use can take a minute each, and a measured
// scenario asks several times. Builds of the API also happen inside a step.
setDefaultTimeout(30 * 60 * 1000);

Before(function (this: ImageWorld, { gherkinDocument }) {
  this.feature = gherkinDocument.feature?.name ?? '';
  fakeGemini.reset();
});

After(function ({ pickle, gherkinDocument, result }) {
  const feature = gherkinDocument.feature?.name ?? '';
  const detail = result?.message?.split('\n')[0] ?? '';
  addOutcome(feature, pickle.name, result?.status ?? 'UNKNOWN', detail);
});

AfterAll(async function () {
  await stopAllServers();
  await closeDb();
  const file = writeReport();
  if (file) console.log(`\n[bdd] report written to ${file}`);
});
