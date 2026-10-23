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
  ansari: {baseUrl?: string; clientName?: string; authorization?: string};
};

/**
 * One reading of the settings for both hosting adapters. `allowedHosts` and `allowedOrigins`
 * replace the defaults only when the caller supplies them; the environment lists are always added.
 */
export function settingsFromEnv(env: RuntimeEnv, overrides: {allowedHosts?: string[]; allowedOrigins?: string[]; enableJsonResponse?: boolean} = {}): EnvSettings {
  const allowedHosts = [...new Set([...(overrides.allowedHosts ?? DEFAULT_ALLOWED_HOSTS), ...list(setting(env, 'MCP_ALLOWED_HOSTS'))])];
  const allowedOrigins = [...new Set([...(overrides.allowedOrigins ?? allowedHosts), ...list(setting(env, 'MCP_ALLOWED_ORIGINS'))])];
  return {
    release: releaseFromEnv(env),
    allowedHosts,
    allowedOrigins,
    enableJsonResponse: overrides.enableJsonResponse ?? setting(env, 'MCP_RESPONSE_MODE') === 'json',
    ansari: {baseUrl: setting(env, 'ANSARI_API_BASE_URL'), clientName: setting(env, 'ANSARI_CLIENT'), authorization: setting(env, 'ANSARI_API_AUTHORIZATION')},
  };
}
