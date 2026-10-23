import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, type IncomingHttpHeaders, type Server} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

// The two hosting targets run as their built artifacts: Node/Docker's dist/server/index.js, and the Workers bundle
// dist-worker/index.js in the local Workers runtime (workerd, through Wrangler). Never an in-process mock.
const root = fileURLToPath(new URL('../', import.meta.url));
export type RuntimeKind = 'node' | 'workers';

export const ANSWER_ATTRIBUTION = '*Answered by [Ansari](https://askansari.ai).*';
export const answerFor = (question: string) => `Synthetic answer to ${question}\n\n${ANSWER_ATTRIBUTION}\n`;
export const PRIVATE_CANARY = 'PRIVATE_UPSTREAM_CANARY';
export const RELEASE = 'parity-1';
/** MCP_ALLOWED_ORIGINS lists hostnames. */
export const TRUSTED_ORIGIN_HOST = 'chat.example';
export const TRUSTED_ORIGIN = `https://${TRUSTED_ORIGIN_HOST}`;
export const UPSTREAM_AUTHORIZATION = 'Bearer synthetic-secret';

export type UpstreamRequest = {headers: IncomingHttpHeaders; question: string};

/**
 * A real HTTP upstream the runtimes call. The question selects its behaviour: `FAIL` answers 500 with a private
 * canary, `slow:<ms>` answers late, `hang` never answers; anything else gets a complete answer with attribution.
 */
export async function startUpstream() {
  const seen: UpstreamRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const question = JSON.parse(body).messages[0].content as string;
      seen.push({headers: req.headers, question});
      if (question === 'hang') return;
      const reply = (status: number, text: string) => { res.writeHead(status, {'content-type': 'text/plain; charset=utf-8'}); res.end(text); };
      if (question === 'FAIL') return reply(500, PRIVATE_CANARY);
      const delay = /^slow:(\d+)$/.exec(question);
      if (delay) return void setTimeout(() => reply(200, answerFor(question)), Number(delay[1]));
      reply(200, answerFor(question));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('upstream did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`, seen,
    async close() { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; },
  };
}

export type Runtime = {
  kind: RuntimeKind;
  origin: string;
  /** Every line the runtime wrote to standard output or error. */
  logs: string[];
  /** Stop the runtime as an operator would; `remaining` is true when any of its processes outlived the stop. */
  close(): Promise<{code: number | null; remaining: boolean}>;
  /** The runtime process is still running. */
  alive(): boolean;
};

export const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const {port} = probe.address() as {port: number}; probe.close(() => resolve(port)); });
});

/** The compatibility settings of wrangler.jsonc, so the built bundle runs under the configuration it is deployed with. */
function workersConfig(): {compatibility_date: string; compatibility_flags: string[]} {
  const text = readFileSync(`${root}wrangler.jsonc`, 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  return JSON.parse(text);
}

export function waitFor(child: ChildProcess, logs: string[], ready: (line: string) => boolean, what: string, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`${what} did not start in ${ms} ms:\n${logs.join('\n')}`));
    }, ms);
    const onLine = (line: string) => { if (ready(line)) { clearTimeout(timer); resolve(line); } };
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({input: stream!}).on('line', line => { logs.push(line); onLine(line); });
    }
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${what} exited with ${code} before it was ready:\n${logs.join('\n')}`)); });
  });
}

export type RuntimeOptions = {json: boolean; upstream: string};

export async function startRuntime(kind: RuntimeKind, options: RuntimeOptions): Promise<Runtime> {
  const settings: Record<string, string> = {
    ANSARI_API_BASE_URL: options.upstream,
    ANSARI_API_AUTHORIZATION: UPSTREAM_AUTHORIZATION,
    ANSARI_CLIENT: 'parity-test',
    ANSARI_RELEASE: RELEASE,
    MCP_ALLOWED_ORIGINS: TRUSTED_ORIGIN_HOST,
    MCP_RESPONSE_MODE: options.json ? 'json' : 'sse',
  };
  const logs: string[] = [];
  let stateDir: string | undefined;
  let child: ChildProcess;
  let origin: string;
  if (kind === 'node') {
    const entry = `${root}dist/server/index.js`;
    if (!existsSync(entry)) throw new Error('dist/server/index.js is missing: run `pnpm build` first');
    child = spawn(process.execPath, [entry], {env: {PATH: process.env.PATH ?? '', ...settings, PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    const line = await waitFor(child, logs, text => text.includes('"event":"startup"'), 'the Node server', 15_000);
    origin = `http://127.0.0.1:${JSON.parse(line).port}`;
  } else {
    const entry = `${root}dist-worker/index.js`;
    if (!existsSync(entry)) throw new Error('dist-worker/index.js is missing: run `pnpm build:worker` first');
    const port = await freePort();
    // Each runtime instance needs its own devtools port; the default is shared by every Wrangler on the host.
    const inspectorPort = await freePort();
    // Local state is per instance too: two Wranglers creating the shared .wrangler/state store at once lock each other out.
    stateDir = mkdtempSync(join(tmpdir(), 'ansari-workers-state-'));
    const config = workersConfig();
    const args = ['dev', entry, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort), '--persist-to', stateDir,
      '--compatibility-date', config.compatibility_date, '--compatibility-flags', config.compatibility_flags.join(','),
      ...Object.entries(settings).flatMap(([name, value]) => ['--var', `${name}:${value}`])];
    // The installed Wrangler command itself (a package-manager shim), as `pnpm exec wrangler` runs it.
    child = spawn(`${root}node_modules/.bin/wrangler`, args, {cwd: root, env: {...process.env, WRANGLER_SEND_METRICS: 'false'}, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    await waitFor(child, logs, text => text.includes('Ready on'), 'the local Workers runtime', 90_000);
    origin = `http://127.0.0.1:${port}`;
  }
  let exitCode: number | null | undefined;
  child.once('exit', code => { exitCode = code; });
  return {
    kind, origin, logs,
    alive: () => exitCode === undefined,
    async close() {
      const groupRunning = () => { try { process.kill(-child.pid!, 0); return true; } catch { return false; } };
      if (exitCode === undefined) {
        const exited = once(child, 'exit');
        // Wrangler starts workerd as its child: end the whole group, as a terminal's Ctrl-C would.
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 10_000);
        await exited;
        clearTimeout(timer);
      }
      // Whatever the exit status, no process of the runtime may outlive its stop.
      for (let waited = 0; groupRunning() && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
      if (stateDir) rmSync(stateDir, {recursive: true, force: true});
      return {code: exitCode ?? null, remaining: groupRunning()};
    },
  };
}
