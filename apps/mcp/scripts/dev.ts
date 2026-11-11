// Local development entry (`pnpm mcp dev`, and the root `pnpm dev`): the Node
// server from source, wired to the local stack. It loads `apps/mcp/.env` when
// present (git-ignored), then fills only what is still unset:
//   PORT 3001 (apps/api has 3000), ANSARI_API_BASE_URL the local apps/api.
// A local apps/api enforces the `ansari-mcp` key like a deployed one (#314):
// put `ANSARI_API_AUTHORIZATION=Bearer ansari_mcp_development_<64 letters>` in
// `.env` (a key from apps/auth's service-keys script against the local auth
// database), or run apps/api with MCP_COMPLETE_KEY_MODE=log-only. Deployments
// never use this file: they run `pnpm start` (dist/) or the Worker entry.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const DEV_DEFAULTS = {PORT: '3001', ANSARI_API_BASE_URL: 'http://localhost:3000'} as const;
for (const [name, value] of Object.entries(DEV_DEFAULTS)) process.env[name] ??= value;

if (process.env.PORT === '3000') {
  console.warn(
    '[mcp dev] PORT is 3000, which apps/api uses under the root `pnpm dev`. Set PORT=3001 in apps/mcp/.env, or ' +
      'drop its PORT line (the dev default is 3001). .env.example keeps PORT=3000 for the Railway service.',
  );
}

if (!process.env.ANSARI_API_AUTHORIZATION) {
  console.warn(
    '[mcp dev] ANSARI_API_AUTHORIZATION is not set: the local apps/api answers 401 unless it runs with ' +
      'MCP_COMPLETE_KEY_MODE=log-only. See apps/mcp/README.md, "Local development".',
  );
}

await import('../src/node/index.js');
