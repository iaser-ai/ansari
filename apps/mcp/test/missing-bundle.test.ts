import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// #375: without a built dist-worker/, the Workers lifecycle test threw before its cleanup and left its upstream server
// listening, so the test file never exited and the whole suite hung. The whole file runs, so the parity cases' cleanup
// is pinned too: it must fail at once, naming the missing build.
test('the Workers tests fail fast, naming the build step, when the Workers bundle is missing', () => {
  // The child must run as its own test run: an inherited NODE_TEST_CONTEXT makes it report to this one and exit 0.
  const {NODE_TEST_CONTEXT: _, ...env} = process.env;
  const run = spawnSync(join(root, 'node_modules/.bin/tsx'), ['--test', 'test/parity-workers.test.ts'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    env: {...env, MCP_TEST_WORKER_ENTRY: join(root, 'dist-worker-missing/index.js')},
  });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.signal, null, `the test file exited on its own instead of hanging:\n${output}`);
  assert.notEqual(run.status, 0, 'the test file fails');
  assert.match(output, /run `pnpm build:worker` first/);
});
