import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DEFAULT_RELEASE} from '../src/server/operation-log.ts';
import {DEFAULT_ALLOWED_HOSTS, releaseFromEnv, settingsFromEnv} from '../src/server/runtime-config.ts';
import {prepareAnswerView} from '../src/server/view-artifact.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the shared application and the Workers entry read no file, process, or Node listener', () => {
  for (const file of ['fetch-app', 'runtime-config', 'view-artifact', 'ansari-client', 'create-server', 'operation-log'].map(name => `src/server/${name}.ts`).concat('src/worker/index.ts')) {
    const source = read(file);
    assert.doesNotMatch(source, /node:(?:fs|http|path|process)|@hono\/node-server|\bprocess\./, `${file} stays runtime-neutral`);
  }
});

test('dependencies point inward: the Node and Workers adapters import src/server, which imports neither adapter', () => {
  const shared = readdirSync(new URL('../src/server/', import.meta.url)).filter(name => name.endsWith('.ts'));
  assert.ok(shared.length > 0);
  for (const name of shared) {
    assert.doesNotMatch(read(`src/server/${name}`), /from\s+['"](?:\.\.\/(?:node|worker)\/|\.\.\/\.\.\/src\/(?:node|worker)\/)/, `src/server/${name} imports no adapter`);
  }
  assert.match(read('src/node/http-server.ts'), /from '\.\.\/server\/fetch-app\.js'/);
  assert.match(read('src/worker/index.ts'), /from '\.\.\/server\/fetch-app\.js'/);
  assert.doesNotMatch(read('src/worker/index.ts'), /\.\.\/node\//, 'the Workers entry does not import the Node adapter');
});

test('the Workers bundle holds the shared application and none of the Node hosting', () => {
  assert.ok(existsSync(new URL('../dist-worker/index.js', import.meta.url)), 'run `pnpm build:worker` first');
  const bundle = read('dist-worker/index.js');
  assert.match(bundle, /ask_ansari/);
  assert.doesNotMatch(bundle, /createAdaptorServer|SIGTERM/, 'no Node listener or signal lifecycle');
});

test('release stamping precedes hashing: equal final bytes share an identity and a release change moves it', () => {
  const unstamped = '<html><body class="card">one</body></html>';
  const stamped = '<html><body class="card" data-revision="old">one</body></html>';
  const a = prepareAnswerView(unstamped, 'r1');
  const b = prepareAnswerView(stamped, 'r1');
  assert.equal(a.html, b.html, 'both end as the same final bytes');
  assert.equal(a.uri, b.uri);
  assert.equal(a.uri, `ui://views/answer-card.${createHash('sha256').update(a.html).digest('hex').slice(0, 32)}.html`);
  assert.match(a.html, /data-revision="r1"/);
  assert.notEqual(prepareAnswerView(unstamped, 'r2').uri, a.uri, 'a legitimate release change moves the hash');
  assert.equal(prepareAnswerView(unstamped, 'r1').uri, a.uri, 'preparing again changes nothing');
});

test('settings come from the supplied bindings, with the same rules under both hosts', () => {
  const none = settingsFromEnv({});
  assert.deepEqual(none.allowedHosts, DEFAULT_ALLOWED_HOSTS);
  assert.deepEqual(none.allowedOrigins, DEFAULT_ALLOWED_HOSTS);
  assert.equal(none.release, DEFAULT_RELEASE);
  assert.equal(none.enableJsonResponse, false);
  assert.deepEqual(none.ansari, {baseUrl: undefined, clientName: undefined, authorization: undefined});

  const configured = settingsFromEnv({
    ANSARI_RELEASE: 'v1.2.3-rc.1', MCP_ALLOWED_HOSTS: ' app.example , ', MCP_ALLOWED_ORIGINS: 'chat.example', MCP_RESPONSE_MODE: 'json',
    ANSARI_API_BASE_URL: 'https://upstream.example', ANSARI_CLIENT: 'beta', ANSARI_API_AUTHORIZATION: 'Bearer x',
  });
  assert.deepEqual(configured.allowedHosts, [...DEFAULT_ALLOWED_HOSTS, 'app.example']);
  assert.deepEqual(configured.allowedOrigins, [...DEFAULT_ALLOWED_HOSTS, 'app.example', 'chat.example']);
  assert.equal(configured.release, 'v1.2.3-rc.1');
  assert.equal(configured.enableJsonResponse, true);
  assert.deepEqual(configured.ansari, {baseUrl: 'https://upstream.example', clientName: 'beta', authorization: 'Bearer x'});

  // The release is stamped into HTML and logs: an unsafe value is never used. The Railway commit is the next source.
  assert.equal(releaseFromEnv({ANSARI_RELEASE: '"><script>', RAILWAY_GIT_COMMIT_SHA: 'abc123'}), 'abc123');
  assert.equal(releaseFromEnv({ANSARI_RELEASE: 'bad value'}), DEFAULT_RELEASE);
  // A binding that is not a string (a Workers service or secret object) is ignored, never coerced.
  assert.equal(releaseFromEnv({ANSARI_RELEASE: {toString: () => 'x'}}), DEFAULT_RELEASE);
});
