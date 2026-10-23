import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it} from 'node:test';
import {freePort, startUpstream, waitFor} from './runtime-harness.ts';

// Wrangler's named environments (wrangler.jsonc) are the only declaration of the Worker targets. These tests cover the
// two ways a real defect could cross an environment boundary: selecting no environment, and a secret falling back from
// another one. They make no claim about a deployment, a Cloudflare account or a host connection.
const ENVIRONMENTS = ['dev', 'beta', 'production'] as const;
const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = join(root, 'node_modules/.bin/wrangler');
const scripts: Record<string, string> = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;

type WorkerConfig = {name?: string; main?: string; workers_dev?: boolean; preview_urls?: boolean; routes?: unknown[]; vars?: Record<string, string>};
/** Wrangler's own reading of wrangler.jsonc for one environment (comments and inheritance included). */
async function readWorker(env: string | undefined): Promise<WorkerConfig> {
  // Loaded by a variable name so this project's strict typecheck does not compile Wrangler's own declaration files.
  const specifier = 'wrangler';
  const {unstable_readConfig: readConfig} = await import(specifier) as {unstable_readConfig: (args: {config: string; env?: string}, options: {hideWarnings: boolean}) => WorkerConfig};
  return readConfig({config: join(root, 'wrangler.jsonc'), env}, {hideWarnings: true});
}

describe('Worker environments', () => {
  it('are three distinct named environments, and a bare deploy has no destination', async () => {
    const workers = await Promise.all(ENVIRONMENTS.map(readWorker));
    for (const field of [(w: WorkerConfig) => w.name, (w: WorkerConfig) => w.vars?.ANSARI_CLIENT, (w: WorkerConfig) => w.vars?.MCP_ALLOWED_HOSTS]) {
      assert.equal(new Set(workers.map(field)).size, 3, 'name, client label and allowed host all differ');
    }
    // The existing Dev Worker keeps its identity.
    assert.equal(workers[0]!.name, 'ansari-faithful-answers-dev');
    assert.equal(workers[0]!.vars?.MCP_ALLOWED_HOSTS, 'ansari-faithful-answers-dev.younes-b2d.workers.dev');
    assert.equal(workers[0]!.vars?.ANSARI_CLIENT, 'machinewisdom-faithful-answers-dev');
    for (const worker of workers) {
      assert.ok(worker.main, 'every environment declares its entry point');
      assert.equal(worker.vars?.ANSARI_API_AUTHORIZATION, undefined, 'a secret is never a plain var');
    }
    const top = await readWorker(undefined);
    assert.equal(top.main, undefined);
    assert.deepEqual(top.vars ?? {}, {});
    assert.deepEqual(top.routes ?? [], []);
    const bare = spawnSync(wrangler, ['deploy', '--dry-run', '--outdir', mkdtempSync(join(tmpdir(), 'ansari-bare-'))], {cwd: root, encoding: 'utf8', env: {...process.env, WRANGLER_SEND_METRICS: 'false'}});
    assert.notEqual(bare.status, 0, 'wrangler deploy without --env must not succeed');
  });

  it('keep version preview URLs off, declared explicitly in each environment', async () => {
    // Wrangler 4.151.3 resolves an omitted `preview_urls` to undefined and then leaves the Worker's current setting alone,
    // which switched them on at a Dev deploy. Only a literal `false` is acceptable, and `workers_dev` stays independent.
    const workers = await Promise.all(ENVIRONMENTS.map(readWorker));
    ENVIRONMENTS.forEach((env, index) => assert.strictEqual(workers[index]!.preview_urls, false, `${env} resolves preview_urls to false`));
    assert.deepEqual(workers.map(worker => worker.workers_dev), [true, false, false], 'only Dev keeps its workers.dev endpoint');
    // Resolved values alone would also pass if the top level declared the setting and the blocks merely inherited it. The file
    // holds only whole-line comments, so dropping them leaves plain JSON.
    const declared = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')) as {preview_urls?: unknown; env: Record<string, {preview_urls?: unknown}>};
    assert.equal(declared.preview_urls, undefined, 'there is no top-level Worker setting');
    for (const env of ENVIRONMENTS) assert.strictEqual(declared.env[env]!.preview_urls, false, `${env} declares preview_urls: false itself`);
    assert.deepEqual(Object.keys(declared.env).sort(), [...ENVIRONMENTS].sort(), 'no other environment escapes the check');
  });

  it('are selected by name in every package script, with the exact revision stamped on a deploy', () => {
    assert.ok(!('deploy' in scripts) && !('dev:worker' in scripts), 'no script runs Wrangler without an environment');
    for (const env of ENVIRONMENTS) {
      const deploy = scripts[`deploy:worker:${env}`];
      assert.ok(deploy, `deploy:worker:${env} exists`);
      assert.match(deploy, new RegExp(`wrangler deploy --env ${env}\\b`));
      assert.match(deploy, /--var ANSARI_RELEASE:\$\(git rev-parse HEAD\)/, 'the release is the exact app revision, never the version-only default');
      assert.equal(scripts[`dev:worker:${env}`], `pnpm guard:dev-vars && pnpm build:worker && CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false wrangler dev --env ${env}`, 'the documented local launch');
    }
    assert.deepEqual(Object.keys(scripts).filter(name => name.startsWith('deploy:')).sort(), ENVIRONMENTS.map(env => `deploy:worker:${env}`).sort());
  });

  it('keep the application source free of any environment name', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    for (const file of walk(join(root, 'src')).filter(name => /\.(ts|tsx)$/.test(name))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\b(?:beta|production)\b/i, `${file} selects no environment`);
    }
  });
});

describe('local Workers runtime, launched as documented', () => {
  it('refuses a generic .dev.vars, which Wrangler would read for every environment', () => {
    const guard = (dir: string) => spawnSync('sh', ['-c', scripts['guard:dev-vars']!], {cwd: dir, encoding: 'utf8'});
    const dir = mkdtempSync(join(tmpdir(), 'ansari-guard-'));
    try {
      writeFileSync(join(dir, '.dev.vars.beta'), 'ANSARI_API_AUTHORIZATION=synthetic\n');
      assert.equal(guard(dir).status, 0, 'an environment-specific file is accepted');
      writeFileSync(join(dir, '.dev.vars'), 'ANSARI_API_AUTHORIZATION=synthetic\n');
      const refused = guard(dir);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /generic \.dev\.vars/);
    } finally { rmSync(dir, {recursive: true, force: true}); }
    for (const env of ENVIRONMENTS) assert.match(scripts[`dev:worker:${env}`]!, /^pnpm guard:dev-vars && /, `dev:worker:${env} runs the guard first`);
  });

  type Started = {origin: string; close(): Promise<void>};
  /**
   * The real wrangler.jsonc (only its entry path made absolute), launched with the setting and arguments of the package
   * script `dev:worker:<env>`, beside `.env` files that no environment may inherit and the given `.dev.vars.<env>` files.
   * (A generic `.dev.vars` never reaches Wrangler: the guard that starts the same script refuses it, tested above.)
   */
  async function startEnvironment(env: string, upstream: string, localSecrets: Record<string, string>): Promise<Started> {
    const dir = mkdtempSync(join(tmpdir(), 'ansari-env-'));
    // `wrangler dev` rewrites the Host header of a request to the hostname of a configured route, which would hide the Host
    // check, so the copy leaves out the `routes` lines.
    const declared = readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replaceAll('"src/worker/index.ts"', JSON.stringify(`${root}src/worker/index.ts`));
    writeFileSync(join(dir, 'wrangler.jsonc'), declared.split('\n').filter(line => !/^\s*"routes":/.test(line)).join('\n'));
    const generic = 'ANSARI_API_AUTHORIZATION=Bearer generic-must-not-leak\n';
    for (const name of ['.env', '.env.local', `.env.${env}`]) writeFileSync(join(dir, name), generic);
    for (const [name, value] of Object.entries(localSecrets)) writeFileSync(join(dir, name), `ANSARI_API_AUTHORIZATION=${value}\n`);
    const launch = (scripts[`dev:worker:${env}`] ?? '').split('&&').pop()!.trim().split(/\s+/);
    const settings = Object.fromEntries(launch.filter(word => /^[A-Z_]+=/.test(word)).map(word => word.split('=') as [string, string]));
    launch.splice(0, Object.keys(settings).length);
    assert.deepEqual(launch.slice(0, 2), ['wrangler', 'dev'], `dev:worker:${env} launches wrangler dev`);
    const [port, inspectorPort] = [await freePort(), await freePort()];
    const logs: string[] = [];
    const child: ChildProcess = spawn(wrangler, [...launch.slice(1), '--config', join(dir, 'wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort),
      '--persist-to', join(dir, 'state'), '--var', `ANSARI_API_BASE_URL:${upstream}`], {cwd: dir, env: {...process.env, ...settings, WRANGLER_SEND_METRICS: 'false'}, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    await waitFor(child, logs, line => line.includes('Ready on'), `the ${env} Worker`, 90_000);
    let exited = false;
    child.once('exit', () => { exited = true; });
    return {
      origin: `http://127.0.0.1:${port}`,
      async close() {
        if (!exited) {
          const done = once(child, 'exit');
          try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, 10_000);
          await done; clearTimeout(timer);
        }
        rmSync(dir, {recursive: true, force: true});
      },
    };
  }

  const call = (origin: string, host: string, question: string) => new Promise<{status: number | undefined; text: string}>((resolve, reject) => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'ask_ansari', arguments: {question}}});
    const req = httpRequest(`${origin}/mcp`, {method: 'POST', headers: {host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body)}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({status: res.statusCode, text}));
    });
    req.on('error', reject); req.end(body);
  });

  it('serves each environment under its own host and client label, and only its own .dev.vars.<env> secret', async () => {
    const workers = Object.fromEntries(await Promise.all(ENVIRONMENTS.map(async env => [env, await readWorker(env)] as const)));
    const upstream = await startUpstream();
    try {
      for (const env of ENVIRONMENTS) {
        // Only Beta has an environment-specific secret file. Dev and Production must see neither it nor the generic
        // `.env` files, which Wrangler would otherwise fall back to.
        const runtime = await startEnvironment(env, upstream.url, {'.dev.vars.beta': 'Bearer beta-only-synthetic'});
        try {
          const before = upstream.seen.length;
          const host = workers[env]!.vars!.MCP_ALLOWED_HOSTS!;
          const own = await call(runtime.origin, host, `question for ${env}`);
          assert.equal(own.status, 200, `${env} answers on its own host`);
          assert.match(own.text, new RegExp(`Synthetic answer to question for ${env}`));
          assert.equal(upstream.seen.length, before + 1);
          const sent = upstream.seen.at(-1)!.headers;
          assert.equal(sent['x-ansari-client'], workers[env]!.vars!.ANSARI_CLIENT);
          assert.equal(sent.authorization, env === 'beta' ? 'Bearer beta-only-synthetic' : undefined, `${env} upstream authorization`);
          for (const other of ENVIRONMENTS.filter(candidate => candidate !== env)) {
            const refused = await call(runtime.origin, workers[other]!.vars!.MCP_ALLOWED_HOSTS!, 'refused');
            assert.equal(refused.status, 403, `${env} refuses the ${other} host`);
          }
          assert.equal(upstream.seen.length, before + 1, 'a refused host never reaches Ansari');
          assert.equal((await fetch(`${runtime.origin}/health`)).status, 200, 'localhost stays allowed');
        } finally { await runtime.close(); }
      }
    } finally { await upstream.close(); }
  });
});
