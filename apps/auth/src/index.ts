// apps/auth — the runnable Better Auth service (spec 300): the only place that
// signs users in, signs them up, resets passwords or manages sessions.
//
// It listens once, on PORT, behind the public domain (owner amendment
// 2026-10-17: no internal listener). The app itself is built in app.ts.
import 'dotenv/config';
import { createDb, getEnv } from '@ansari/auth';

import { initSentry } from './alerts';
import { createApp, createServiceAuth } from './app';
import { assertSchema } from './boot';

const env = getEnv();
initSentry(env.SENTRY_DSN, env.NODE_ENV);

// No admin check at boot (owner amendment 2026-10-17): admin is the role in
// auth.users alone, granted by scripts/grant-admin.ts, and the window audits it
// (05-audit-admins-auth.sql), so a stale list can never stop sign-in. The one
// boot check is the schema (boot.ts), and it stops the service only when a
// migration is definitely missing.
const db = createDb();

const auth = createServiceAuth(db);

if (!(await assertSchema(db))) process.exit(1);

createApp({ auth, db }).listen(env.PORT, () => {
  console.log(`auth service listening on port ${env.PORT}`);
});
