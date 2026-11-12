import {DEFAULT_RELEASE, SAFE_REVISION} from './operation-log.js';

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

/** The deployed revision: `ANSARI_RELEASE` when it is a safe identifier, else the application version. */
export function releaseFromEnv(env: RuntimeEnv): string {
  const value = setting(env, 'ANSARI_RELEASE');
  return value && SAFE_REVISION.test(value) ? value : DEFAULT_RELEASE;
}

export type EnvSettings = {
  release: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  enableJsonResponse: boolean;
  ansari: {baseUrl?: string; clientName?: string; authorization?: string};
};

/** Explicit overrides, then configured lists (including empty), then local defaults. */
function allowedList(value: unknown, override: string[] | undefined, fallback: string[]): string[] {
  const selected = override ?? (typeof value === 'string' ? list(value) : fallback);
  return [...new Set(selected.map(item => item.trim()).filter(Boolean))];
}

/** One configuration boundary shared by the Node and Workers adapters. */
export function settingsFromEnv(env: RuntimeEnv, overrides: {allowedHosts?: string[]; allowedOrigins?: string[]; enableJsonResponse?: boolean} = {}): EnvSettings {
  const allowedHosts = allowedList(env.MCP_ALLOWED_HOSTS, overrides.allowedHosts, DEFAULT_ALLOWED_HOSTS);
  const allowedOrigins = allowedList(env.MCP_ALLOWED_ORIGINS, overrides.allowedOrigins, allowedHosts);
  return {
    release: releaseFromEnv(env),
    allowedHosts,
    allowedOrigins,
    enableJsonResponse: overrides.enableJsonResponse ?? setting(env, 'MCP_RESPONSE_MODE') === 'json',
    ansari: {baseUrl: setting(env, 'ANSARI_API_BASE_URL'), clientName: setting(env, 'ANSARI_CLIENT'), authorization: setting(env, 'ANSARI_API_AUTHORIZATION')},
  };
}
