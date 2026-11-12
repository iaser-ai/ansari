import { vi } from 'vitest';

/**
 * The shared key stub for suites that call `/api/v2/mcp-complete` (#314).
 *
 * The route now asks apps/auth's verify route about the caller's key before it
 * reads the body. Suites that test something else about the route present a
 * key and stub that one call at the HTTP boundary with a valid answer, so the
 * real `verifyServiceKey` and `authServiceFetch` still run:
 *
 * - `installMcpKeyStub()` stubs global `fetch` for `<AUTH_URL>/api/service/verify-key`
 *   and passes every other URL to the original fetch. Unless `env: false`
 *   (suites that mock `@/lib/config` and spread `MCP_KEY_CONFIG` into it), it
 *   also sets, with `vi.stubEnv`, whichever of apps/api's required variables
 *   and the `AUTH_*` coordinates the suite has not set, so `config` resolves.
 * - `withMcpKey(headers)` adds `Authorization: Bearer <MCP_TEST_KEY>`.
 *
 * Undo with `vi.unstubAllGlobals()` and `vi.unstubAllEnvs()` (and the config
 * module's `resetEnvCache()` when it is real).
 */

export const MCP_TEST_AUTH_URL = 'https://auth.mcp-key-test.example';
export const MCP_TEST_LAYER_ORIGIN = 'https://api.mcp-key-test.example';
export const MCP_TEST_CLIENT_ID = 'ansari-mcp-test';
export const MCP_TEST_KEY_ID = 'key-00000000-0000-4000-8000-000000000314';
/** A key in the issued shape: the public prefix and 64 random letters. */
// A shape the service-keys script can issue: keyPrefix('ansari-mcp', 'staging')
// in packages/auth/src/service-users.ts. A literal, since apps/api may not
// import @ansari/auth (source-scan 3).
export const MCP_TEST_KEY = `ansari_mcp_staging_${'kQ'.repeat(32)}`;

const VERIFY_PATH = '/api/service/verify-key';

/** For suites that mock `@/lib/config`: the two members the route's key gate reads. */
export const MCP_KEY_CONFIG = {
  authService: {
    url: MCP_TEST_AUTH_URL,
    jwtIssuer: MCP_TEST_AUTH_URL,
    jwtAudience: 'ansari-api-mcp-key-test',
    layerOrigin: MCP_TEST_LAYER_ORIGIN,
  },
  mcpCompleteKeyMode: 'enforce' as const,
};

const DEFAULT_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  KALEMAT_API_KEY: 'placeholder',
  USUL_API_TOKEN: 'placeholder',
  ENVIRONMENT: 'development',
  AUTH_URL: MCP_TEST_AUTH_URL,
  AUTH_JWT_ISSUER: MCP_TEST_AUTH_URL,
  AUTH_JWT_AUDIENCE: 'ansari-api-mcp-key-test',
  AUTH_LAYER_ORIGIN: MCP_TEST_LAYER_ORIGIN,
};

export interface McpKeyStub {
  /** Calls the stub answered (verify calls only). */
  verifyCalls: () => number;
}

export async function installMcpKeyStub(options: { env?: boolean } = {}): Promise<McpKeyStub> {
  let authUrl = MCP_TEST_AUTH_URL;
  if (options.env !== false) {
    for (const [name, value] of Object.entries(DEFAULT_ENV)) {
      if (!process.env[name]) vi.stubEnv(name, value);
    }
    authUrl = process.env.AUTH_URL as string;
    const { resetEnvCache } = await import('@/lib/config');
    resetEnvCache();
  }

  const verifyUrl = new URL(VERIFY_PATH, authUrl).href;
  const original = globalThis.fetch;
  let calls = 0;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== verifyUrl) return original(input, init);
    calls += 1;
    return Promise.resolve(
      Response.json({ valid: true, client_id: MCP_TEST_CLIENT_ID, key_id: MCP_TEST_KEY_ID })
    );
  });
  return { verifyCalls: () => calls };
}

export function withMcpKey(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, authorization: `Bearer ${MCP_TEST_KEY}` };
}
