// The Express app apps/auth serves (plan P-1, owner amendment 2026-10-17),
// built without listening so tests can drive it. One listener, behind the
// public domain; there is no internal listener and no shared credential.
//
//   /api/auth/*     Better Auth's router (its JWKS at /api/auth/jwks included)
//   /api/account/*  the account endpoints, bound to the caller's own JWT
//   /health and the diag route
import { createAuth, getEnv, type Auth, type Db, type Mailer } from '@ansari/auth';
import { toNodeHandler } from 'better-auth/node';
import express, { type Express, type Request, type Response } from 'express';

import type { FailedSignInAlert, ListWalkAlert } from './alerts';
import { createPerimeterHooks } from './limits/email-limiter';
import { blockedPaths } from './middleware/blocked-paths';
import { requireClientIp } from './middleware/client-ip';
import { corsFor, mergeExposedHeaders } from './middleware/cors';
import { ACCOUNT_PATH, accountRouter } from './routes/account';
import { clientIpDiag, DIAG_PATH } from './routes/diag';
import { health } from './routes/health';

export type ServiceDeps = { auth: Auth; db: Db };
export type AppOptions = {
  /** Refuse router requests with no usable client IP. Defaults to NODE_ENV=production. */
  production?: boolean;
};

const AUTH_ROUTE = '/api/auth{/*path}';

export type ServiceAuthOptions = {
  alert?: (alert: ListWalkAlert) => void;
  failedSignInAlert?: (alert: FailedSignInAlert) => void;
  /** The reset-email transport; Resend by default. */
  mailer?: Mailer;
};

/** The configured Better Auth instance with apps/auth's limiters as its hooks. */
export function createServiceAuth(
  db: Db,
  { alert, failedSignInAlert, mailer }: ServiceAuthOptions = {}
): Auth {
  const hooks = createPerimeterHooks({ db, alert, failedSignInAlert });
  return createAuth(db, { ...hooks, mailer });
}

function isProduction(options: AppOptions): boolean {
  return options.production ?? getEnv().NODE_ENV === 'production';
}

/**
 * The JWKS path apps/api's verifier fetches (apps/api `lib/auth/verify-jwt.ts`),
 * on Better Auth's router under its per-IP default, at most once per 30 s cooldown.
 */
export const JWKS_ROUTE = '/api/auth/jwks';

function notFound(_req: Request, res: Response): void {
  res.status(404).end();
}

export function createApp({ auth, db }: ServiceDeps, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsFor(getEnv().CORS_ORIGIN));
  app.use(mergeExposedHeaders);
  app.use(blockedPaths);
  app.get('/health', health(db));
  app.get(DIAG_PATH, clientIpDiag);
  // Outside Better Auth's handler path (spec 300 rule 8), so none of its
  // per-IP limits apply; each endpoint has a per-user budget instead.
  app.use(ACCOUNT_PATH, accountRouter({ auth, db }));
  // Better Auth reads the raw body, so no body parser runs before it.
  app.all(AUTH_ROUTE, requireClientIp(isProduction(options)), toNodeHandler(auth));
  app.use(notFound);
  return app;
}
