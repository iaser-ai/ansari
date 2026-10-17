import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { BDD_DIR, hasRealGemini, requireSettings, settings } from './env.ts';
import { fakeGemini } from './fake-gemini.ts';
import { addWarning } from './report.ts';

/**
 * Each profile is the REAL API server (`next start` on the API branch) with a
 * different environment. Profiles start on first use and stay up for the run.
 */
export type Profile = 'real-gemini' | 'inkling-primary' | 'broken-gemini' | 'fake-gemini';

const PROFILE_BY_PHRASE: Record<string, Profile> = {
  'real Gemini': 'real-gemini',
  'Inkling as the main model': 'inkling-primary',
  'a broken Gemini that rejects every call': 'broken-gemini',
  'a fake Gemini that always returns an empty answer': 'fake-gemini',
  'a fake Gemini that always answers': 'fake-gemini',
};

export function profileFor(phrase: string): Profile {
  const profile = PROFILE_BY_PHRASE[phrase];
  if (!profile) throw new Error(`Unknown server setup "${phrase}"`);
  return profile;
}

// The tool keys must exist for the server's config to load. Under a fake or
// broken model no tool is ever called, so a placeholder is enough there.
const PLACEHOLDER = 'placeholder-not-a-real-key';

const PASSTHROUGH = [
  'DATABASE_URL',
  'JWT_SECRET',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_FALLBACK_MODEL',
  'TINKER_API_KEY',
  'INKLING_API_KEY',
  'INKLING_MODEL',
  'KALEMAT_API_KEY',
  'USUL_API_TOKEN',
];

const RUN_JWT_SECRET = randomBytes(32).toString('hex');

function baseEnv(): Record<string, string> {
  // Built from scratch, not copied from this process: the runner's own
  // NODE_OPTIONS (tsx) must not leak into the server.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    USER: process.env.USER ?? '',
    DATABASE_URL: settings.databaseUrl,
    // Random per run: the server only needs some secret, and no literal secret
    // sits in this file for the repo's gitleaks scan to flag.
    JWT_SECRET: RUN_JWT_SECRET,
  };
  for (const name of PASSTHROUGH) {
    const v = settings.value(name);
    if (v) env[name] = v;
  }
  return env;
}

/**
 * Opt-in (ALLOW_MISSING_USUL=true): run without a Usul token. The server's
 * Usul searches then fail and the answer says it could not consult that
 * source, so answers use fewer tokens than in production. The report says so.
 */
function fillMissingUsul(env: Record<string, string>): void {
  if (env.USUL_API_TOKEN || settings.value('ALLOW_MISSING_USUL') !== 'true') return;
  env.USUL_API_TOKEN = PLACEHOLDER;
  addWarning(
    'Run WITHOUT a Usul token (ALLOW_MISSING_USUL=true): the fiqh encyclopedia and tafsir searches failed, ' +
      'so answers that would use them did less work. Cost and latency are lower than production; ' +
      'rerun with a real USUL_API_TOKEN before quoting these numbers.'
  );
}

/**
 * Check what the server will actually receive (after any placeholder was
 * filled in), not only what bdd/.env says.
 */
function requireToolKeys(env: Record<string, string>, extra: string[], why: string): void {
  const missing = [...extra, 'KALEMAT_API_KEY', 'USUL_API_TOKEN'].filter((n) => !env[n]);
  if (missing.length > 0) {
    throw new Error(`${why}: set ${missing.join(', ')} in bdd/.env (see bdd/.env.example)`);
  }
}

async function envFor(profile: Profile): Promise<Record<string, string>> {
  const env = baseEnv();
  if (profile !== 'fake-gemini') fillMissingUsul(env);
  switch (profile) {
    case 'real-gemini':
      if (!hasRealGemini()) requireSettings(['GOOGLE_CLOUD_PROJECT or GEMINI_API_KEY'], 'real Gemini');
      requireToolKeys(env, [], 'real Gemini (its tools)');
      return env;
    case 'inkling-primary':
      requireToolKeys(env, ['TINKER_API_KEY'], 'Inkling as the main model');
      // Only thread naming touches Gemini here, fire-and-forget.
      if (!hasRealGemini()) env.GEMINI_API_KEY = PLACEHOLDER;
      return { ...env, PRIMARY_BACKEND: 'inkling' };
    case 'broken-gemini':
      // A real Gemini call that really fails: Google rejects an unknown model.
      if (!hasRealGemini()) requireSettings(['GOOGLE_CLOUD_PROJECT or GEMINI_API_KEY'], 'broken Gemini');
      requireToolKeys(env, ['TINKER_API_KEY'], 'broken Gemini');
      return {
        ...env,
        GEMINI_MODEL: 'gemini-model-that-does-not-exist',
        GEMINI_FALLBACK_MODEL: 'gemini-model-that-does-not-exist',
      };
    case 'fake-gemini': {
      // The public-API client path, aimed at the fake. Vertex settings are
      // dropped so the SDK does not try Google auth.
      for (const k of ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON']) {
        delete env[k];
      }
      return {
        ...env,
        GEMINI_API_KEY: 'fake-gemini-key',
        GEMINI_MODEL: 'fake-gemini',
        GEMINI_FALLBACK_MODEL: 'fake-gemini',
        GOOGLE_GEMINI_BASE_URL: await fakeGemini.start(),
        KALEMAT_API_KEY: env.KALEMAT_API_KEY ?? PLACEHOLDER,
        USUL_API_TOKEN: env.USUL_API_TOKEN ?? PLACEHOLDER,
      };
    }
  }
}

const LOG_DIR = path.join(BDD_DIR, 'results', 'logs');
const running = new Map<Profile, { child: ChildProcess; baseUrl: string }>();
let built = false;

/**
 * Rebuild the API when its code (apps/api or the shared packages) changed
 * since the last build, so a run never tests stale code after a fix.
 */
function ensureBuilt(): void {
  if (built) return;
  const dir = settings.apiDir;
  if (!existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`API_DIR ${dir} is not the API app (set API_DIR in bdd/.env)`);
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const fingerprint = `${git('rev-parse', 'HEAD')}\n${git('status', '--porcelain', '--', '.', '../../packages')}`;
  const stamp = path.join(dir, '.next', 'bdd-build-fingerprint');
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== fingerprint) {
    console.log(`\n[bdd] building the API in ${dir} (its code changed since the last build)…`);
    execFileSync(settings.apiNode, ['node_modules/next/dist/bin/next', 'build'], {
      cwd: dir,
      env: { ...baseEnv(), GEMINI_API_KEY: PLACEHOLDER, KALEMAT_API_KEY: PLACEHOLDER, USUL_API_TOKEN: PLACEHOLDER },
      stdio: 'inherit',
    });
    writeFileSync(stamp, fingerprint);
  }
  built = true;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer(profile: Profile): Promise<string> {
  const existing = running.get(profile);
  if (existing) return existing.baseUrl;

  const env = await envFor(profile);
  ensureBuilt();
  mkdirSync(LOG_DIR, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = path.join(LOG_DIR, `${profile}.log`);
  const log = createWriteStream(logPath, { flags: 'w' });
  const child = spawn(
    settings.apiNode,
    ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'],
    { cwd: settings.apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  running.set(profile, { child, baseUrl });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      running.delete(profile);
      throw new Error(`API server (${profile}) exited during start; see ${logPath}`);
    }
    try {
      await fetch(`${baseUrl}/api/v2/threads`);
      return baseUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`API server (${profile}) did not start within 60s; see ${logPath}`);
}

export async function stopAllServers(): Promise<void> {
  for (const { child } of running.values()) {
    child.kill('SIGTERM');
  }
  running.clear();
  await fakeGemini.stop();
}
