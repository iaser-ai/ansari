import {DEFAULT_RELEASE, SAFE_REVISION, type LogLevel} from './operation-log.js';

/** Plain string settings: the Node environment, or the Workers `env` bindings. */
export type RuntimeEnv = Readonly<Record<string, unknown>>;

export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1'];
function setting(env: RuntimeEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

/** The deployed revision: an explicit release, then the Railway commit, then the application version. */
export function releaseFromEnv(env: RuntimeEnv): string {
  for (const value of [setting(env, 'ANSARI_RELEASE'), setting(env, 'RAILWAY_GIT_COMMIT_SHA')]) {
    if (value && SAFE_REVISION.test(value)) return value;
  }
  return DEFAULT_RELEASE;
}

export type EnvSettings = {
  release: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  enableJsonResponse: boolean;
  /** First-load diagnosis: the public origin the card's beacon reports to. Unset unless a deployment is being diagnosed. */
  viewDiagnosticsOrigin?: string;
  /** The lowest level written: `debug` while a deployment is measured, `info` otherwise. */
  logLevel: Extract<LogLevel, 'info' | 'debug'>;
  ansari: {baseUrl?: string; clientName?: string; authorization?: string};
};

/** A bare https origin (http only for a local listener), or a startup error: a wrong value must not pass silently. */
function diagnosticsOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const refuse = (): never => { throw new Error(`MCP_VIEW_DIAGNOSTICS_ORIGIN must be a bare origin such as https://mcp.example: ${JSON.stringify(value)}`); };
  let url: URL;
  try { url = new URL(value); } catch { return refuse(); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) refuse();
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.includes('?') || value.includes('#')) refuse();
  return url.origin;
}

/**
 * `MCP_LOG_LEVEL` (`info` or `debug`). A diagnostic card implies `debug`, since its reports are debug records; asking
 * for both a diagnostic card and `info` would drop every report, so it is a startup error.
 */
function logLevel(value: string | undefined, diagnosing: boolean): EnvSettings['logLevel'] {
  if (value !== undefined && value !== 'info' && value !== 'debug') throw new Error(`MCP_LOG_LEVEL must be info or debug: ${JSON.stringify(value)}`);
  if (diagnosing && value === 'info') throw new Error('MCP_LOG_LEVEL=info would drop the reports MCP_VIEW_DIAGNOSTICS_ORIGIN asks for; unset it or use debug');
  return value ?? (diagnosing ? 'debug' : 'info');
}

/** Explicit overrides, then configured lists (including empty), then local defaults. */
function allowedList(value: unknown, override: string[] | undefined, fallback: string[]): string[] {
  const selected = override ?? (typeof value === 'string' ? list(value) : fallback);
  return [...new Set(selected.map(item => item.trim()).filter(Boolean))];
}

/** One configuration boundary shared by the Node and Workers adapters. */
export function settingsFromEnv(env: RuntimeEnv, overrides: {allowedHosts?: string[]; allowedOrigins?: string[]; enableJsonResponse?: boolean} = {}): EnvSettings {
  const allowedHosts = allowedList(env.MCP_ALLOWED_HOSTS, overrides.allowedHosts, DEFAULT_ALLOWED_HOSTS);
  const allowedOrigins = allowedList(env.MCP_ALLOWED_ORIGINS, overrides.allowedOrigins, allowedHosts);
  const viewDiagnosticsOrigin = diagnosticsOrigin(setting(env, 'MCP_VIEW_DIAGNOSTICS_ORIGIN'));
  return {
    release: releaseFromEnv(env),
    allowedHosts,
    allowedOrigins,
    enableJsonResponse: overrides.enableJsonResponse ?? setting(env, 'MCP_RESPONSE_MODE') === 'json',
    viewDiagnosticsOrigin,
    logLevel: logLevel(setting(env, 'MCP_LOG_LEVEL'), viewDiagnosticsOrigin !== undefined),
    ansari: {baseUrl: setting(env, 'ANSARI_API_BASE_URL'), clientName: setting(env, 'ANSARI_CLIENT'), authorization: setting(env, 'ANSARI_API_AUTHORIZATION')},
  };
}
