// Better Auth configuration — the whole auth "brain" for the Ansari monorepo.
//
// apps/auth is the runnable service that mounts it (spec 300: the only place
// that signs users in, signs them up, resets passwords or manages sessions).
// Every setting below that the cutover depends on is pinned by a test in
// tests/ that fails when the setting is removed.
import { CLIENT_HEADER, CLIENT_SRC_PARAM, parseClientId } from '@ansari/types/attribution';
import { expo } from '@better-auth/expo';
import { APIError, BASE_ERROR_CODES, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { admin, bearer, jwt } from 'better-auth/plugins';
import { z } from 'zod';

import { createDb, type Db } from './db';
import { getEnv, type AuthEnv } from './env';
import { DEFAULT_RULE, LONGEST_WINDOW, ROUTER_RULES } from './limits';
import { deriveName } from './name';
import { subscribeToNewsletter } from './newsletter';
import {
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
  weakPasswordMessage,
} from './password';
import { isReservedAddress, normalizeEmail } from './reserved';
import { createResetPasswordSender, resendMailer, type Mailer } from './reset-email';
import * as schema from './schema';

export * as schema from './schema';
export { createDb, pingDatabase, type Db } from './db';
export { getEnv, resetEnvCache, type AuthEnv } from './env';
export * as limits from './limits';
export { consumeWindow, keysSeenSince, peekWindow, touchKey, type WindowState } from './rate-limit-store';
export { isSystemAddress, normalizeEmail, SYSTEM_EMAIL_DOMAIN } from './reserved';
export * as users from './users';
export {
  resetEmailHtml,
  resetLink,
  RESET_EMAIL_FROM,
  RESET_EMAIL_SUBJECT,
  type EmailMessage,
  type Mailer,
} from './reset-email';
export { CLIENT_HEADER } from '@ansari/types/attribution';

const DAY = 24 * 60 * 60;

/** Same bounds as the legacy register schema, and better-auth's own defaults. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** The JWT access-token lifetime: the revocation window (spec 300, item 11). */
export const JWT_EXPIRATION = '15m';

/** The one response for a taken OR reserved address, so sign-up is no oracle. */
export const EMAIL_TAKEN_MESSAGE = 'An account with this email already exists';

/** The legacy reset failure, for a missing, unknown, expired or used token. */
export const INVALID_RESET_TOKEN_MESSAGE = 'Invalid or expired reset token';

/**
 * better-auth's own 429, for apps/auth's limiters. Built here so the error is
 * an instance of the better-auth copy that runs the router (apps/auth resolves
 * a second copy, whose APIError the router would not recognize).
 */
export function tooManyRequests(retryAfterSeconds: number): APIError {
  return new APIError(
    'TOO_MANY_REQUESTS',
    { message: 'Too many requests. Please try again later.' },
    { 'X-Retry-After': String(retryAfterSeconds) }
  );
}

/**
 * True when an endpoint's result (`ctx.context.returned` in an after hook) is
 * an error response. Duck-typed on `statusCode`, so it holds for better-call's
 * base APIError as well as better-auth's subclass.
 */
export function isAuthError(value: unknown): boolean {
  if (!(value instanceof Error) || !('statusCode' in value)) return false;
  const status = (value as { statusCode: unknown }).statusCode;
  return typeof status === 'number' && status >= 400;
}

function emailTaken(): APIError {
  return new APIError('CONFLICT', { message: EMAIL_TAKEN_MESSAGE, code: 'USER_ALREADY_EXISTS' });
}

function weakPassword(suggestions: string[]): APIError {
  return new APIError('BAD_REQUEST', {
    message: weakPasswordMessage(suggestions),
    code: 'PASSWORD_TOO_WEAK',
  });
}

type Body = Record<string, unknown>;

function asBody(body: unknown): Body {
  return body && typeof body === 'object' ? (body as Body) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The client id a sign-up came through, from `X-Ansari-Client` (or `?src=`),
 * by the parser apps/api shares. NULL when neither was sent.
 */
function registeredVia(headers: Headers | undefined, url: string | undefined): string | null {
  const srcParam = url ? new URL(url).searchParams.get(CLIENT_SRC_PARAM) : null;
  return parseClientId(headers?.get(CLIENT_HEADER) ?? null, srcParam).clientId;
}

/** The context better-auth hands a `hooks.before` / `hooks.after` middleware. */
export type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * apps/auth's perimeter hooks (its per-email and reset limiters). `before` runs
 * first in `hooks.before`, ahead of every guard here, so a limit counts every
 * request; it may throw an APIError. `after` runs first in `hooks.after`.
 */
export type AuthExtensions = {
  before?: (ctx: AuthHookContext) => Promise<void>;
  after?: (ctx: AuthHookContext) => Promise<void>;
  /** Delivers the reset email. Defaults to Resend with RESEND_API_KEY. */
  mailer?: Mailer;
};

/**
 * Router paths that never answer: the whole admin plugin surface, the two
 * profile-changing routes, and change-password (spec 300). The plugin stays
 * only for its `role` and ban columns. No client changes a password while
 * signed in, and Better Auth's route would skip the strength guard and keep
 * the other sessions alive; a future feature must add both. better-auth
 * matches `disabledPaths` exactly, so apps/auth also blocks every variant of
 * these paths before its handler.
 */
export const ADMIN_PATHS: readonly string[] = Object.values(admin().endpoints).map(
  (endpoint) => endpoint.path
);
export const BLOCKED_AUTH_PATHS: readonly string[] = [
  ...ADMIN_PATHS,
  '/change-email',
  '/update-user',
  '/change-password',
];

/**
 * better-auth prunes `rate_limit` rows older than the longest window it knows
 * of. apps/auth's own rows live in the same table with longer windows (the
 * per-email reset cap is an hour), so this rule, which matches no path, makes
 * the pruner keep every row for the longest window in limits.ts.
 */
const rateLimitRetention = {
  id: 'ansari-rate-limit-retention' as const,
  rateLimit: [{ pathMatcher: () => false, window: LONGEST_WINDOW, max: 1 }],
};

/**
 * Development-only origins: `exp://` is Expo Go, `http://localhost:8081` is
 * Metro's web/dev server. Neither is a production client, and a production
 * service (NODE_ENV=production, staging included) never trusts them.
 */
export const DEV_TRUSTED_ORIGINS = ['exp://', 'http://localhost:8081'] as const;

/** The origins Better Auth trusts for this environment. */
export function trustedOriginsFor(
  env: Pick<AuthEnv, 'CORS_ORIGIN' | 'AUTH_LAYER_ORIGIN' | 'NODE_ENV'>
): string[] {
  return [
    ...env.CORS_ORIGIN,
    env.AUTH_LAYER_ORIGIN,
    'ansarichat://',
    ...(env.NODE_ENV === 'production' ? [] : DEV_TRUSTED_ORIGINS),
  ];
}

/**
 * Build a configured Better Auth instance.
 *
 * @param db - optional Drizzle client. Defaults to the package's own
 *   node-postgres client. Injectable so tests can pass a throwaway database.
 * @param extensions - apps/auth's perimeter hooks; none in library tests.
 */
export function createAuth(db: Db = createDb(), extensions: AuthExtensions = {}) {
  const env: AuthEnv = getEnv();

  // A browser SILENTLY DISCARDS a `Secure` cookie sent over plain HTTP, so
  // hardcoding secure:true breaks local web login (http://localhost:8081) with
  // no visible error. Tie cookie security to the actual transport: Secure iff
  // the service is served over HTTPS (its baseURL is https).
  const secureCookies = env.BETTER_AUTH_URL.startsWith('https://');

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    // CORS_ORIGIN is the web origins; the rest are the Expo app's origins. The
    // custom scheme MUST match apps/frontend/app.json (`"scheme": "ansarichat"`,
    // the legacy store app's scheme, kept by its successor — #262)
    // — a native request carries `expo-origin: ansarichat://…`, and a mismatch
    // fails origin validation in production. AUTH_LAYER_ORIGIN is apps/api's,
    // for its server-side layer calls; it is not a CORS origin. The dev origins
    // (Expo Go, Metro web) are trusted outside production only.
    trustedOrigins: trustedOriginsFor(env),
    disabledPaths: [...BLOCKED_AUTH_PATHS],
    // The user model is `auth.users` (schema.ts). Ids are UUIDs, generated by
    // the database default, so a migrated user keeps the UUID their app data
    // already references.
    user: {
      modelName: 'users',
      additionalFields: {
        first_name: { type: 'string', required: false, fieldName: 'firstName' },
        last_name: { type: 'string', required: false, fieldName: 'lastName' },
        // Set by the server from X-Ansari-Client, never by the client.
        registered_via: {
          type: 'string',
          required: false,
          input: false,
          fieldName: 'registeredVia',
        },
      },
      // The profile copy in the app database cannot follow an email change
      // until a sync design exists (spec 300 follow-up), so it is off.
      changeEmail: { enabled: false },
      // Deletion goes through apps/auth's account endpoint, never this route.
      deleteUser: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // Permanent bcrypt + scrypt dual verify (password.ts).
      password: { hash: hashPassword, verify: verifyPassword },
      // A reset kills every session, so no new JWT can be minted from one.
      revokeSessionsOnPasswordReset: true,
      // The emailed link has the legacy shape (reset-email.ts), not
      // better-auth's own `/reset-password/:token` callback URL.
      sendResetPassword: createResetPasswordSender(
        env.FRONTEND_URL,
        extensions.mailer ?? resendMailer(env.RESEND_API_KEY)
      ),
      // `requireEmailVerification` stays unset: migrated users are copied with
      // emailVerified = true, and new users sign in at once, as today.
    },
    // No verification email is ever sent, to a copied user or anyone else
    // (scenario 9i): there is no sendVerificationEmail at all.
    emailVerification: { sendOnSignUp: false },
    // 30 days, slid forward at most once a day by any session use, including
    // the session → JWT exchange at /token. Better Auth's defaults are 7d / 1d.
    session: { expiresIn: 30 * DAY, updateAge: 1 * DAY },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: DEFAULT_RULE.window,
      max: DEFAULT_RULE.max,
      customRules: { ...ROUTER_RULES },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await extensions.before?.(ctx);
        if (ctx.path === '/sign-up/email') return signUpGuard(ctx.body, ctx.context);
        if (ctx.path === '/reset-password') {
          return resetGuard(asBody(ctx.body), ctx.query, ctx.context);
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        await extensions.after?.(ctx);
        if (ctx.path !== '/sign-up/email') return;
        if (asBody(ctx.body).register_to_mail_list !== true) return;
        const user = ctx.context.newSession?.user as
          | { email: string; first_name?: string | null; last_name?: string | null }
          | undefined;
        if (!user) return;
        // Fire-and-forget: a failed subscribe never fails a sign-up. Nothing
        // here logs the email.
        void subscribeToNewsletter(
          env.MARKETMAKER_URL,
          user.email,
          user.first_name ?? null,
          user.last_name ?? null
        )
          .then((result) => {
            if (!result.success) console.error('Newsletter subscription failed:', result.error);
          })
          .catch((err: unknown) => {
            console.error(
              'Newsletter subscription unexpected error:',
              err instanceof Error ? err.name : 'unknown'
            );
          });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            // Defence in depth behind signUpGuard: no path may ever create a
            // reserved address in the auth database.
            if (isReservedAddress(user.email)) throw emailTaken();
            const extra = user as typeof user & { first_name?: string | null; last_name?: string | null };
            return {
              data: {
                ...user,
                name: user.name?.trim() ? user.name : deriveName(extra.first_name, extra.last_name, user.email),
                registered_via: registeredVia(ctx?.headers ?? ctx?.request?.headers, ctx?.request?.url),
              },
            };
          },
        },
      },
    },
    advanced: {
      database: {
        generateId: 'uuid',
      },
      // The client IP is X-Real-IP alone (spec 300, Client IP): Railway's edge
      // overwrites it. X-Forwarded-For is never read, and trustedProxies stays
      // unset, because Railway publishes no stable proxy ranges.
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
      // Explicit, so NODE_ENV=test runs the same origin check as production
      // (better-auth skips it under test when this is unset, #266).
      disableOriginCheck: false,
      defaultCookieAttributes: {
        // sameSite:'none' lets the session cookie ride cross-origin requests
        // from the Expo app / a web client on a different origin. But the cookie
        // spec REQUIRES Secure alongside SameSite=None, and Secure needs HTTPS —
        // so over plain HTTP (local dev) we must drop to 'lax' + non-Secure or
        // the browser discards the cookie. Both attributes track the transport
        // together via `secureCookies`.
        sameSite: secureCookies ? 'none' : 'lax',
        secure: secureCookies,
        httpOnly: true,
      },
    },
    plugins: [
      expo(),
      // `requireSignature` stays UNSET: the compatibility layer holds the raw
      // session token (the legacy refresh_token), and better-auth 1.7.7 accepts
      // an unsigned bearer only then (dist/plugins/bearer/index.mjs:34-37).
      bearer(),
      jwt({
        jwks: { keyPairConfig: { alg: 'EdDSA' } },
        jwt: {
          issuer: env.AUTH_JWT_ISSUER,
          audience: env.AUTH_JWT_AUDIENCE,
          expirationTime: JWT_EXPIRATION,
          // The default payload is the whole user object (email, names). Only
          // the subject and the session id go into a token.
          definePayload: ({ user, session }) => ({ sub: user.id, sid: session.id }),
        },
      }),
      // Kept for its `role` and ban columns; its HTTP surface is blocked in
      // apps/auth (spec 300).
      admin(),
      rateLimitRetention,
    ],
  });
}

type HookContext = {
  internalAdapter: {
    findUserByEmail: (email: string) => Promise<unknown>;
    findVerificationValue: (
      identifier: string
    ) => Promise<{ expiresAt: Date } | null | undefined>;
  };
};

/**
 * `/sign-up/email`, in the legacy register order (no oracle):
 *   validation → reserved or taken (one identical 409) → strength → create.
 * The email and length checks run here, so validation stays first whether or
 * not better-auth's own body validation would have run before this hook. The
 * name is derived when the client sent none.
 */
async function signUpGuard(rawBody: unknown, context: HookContext) {
  const body = asBody(rawBody);
  const email = str(body.email);
  const password = str(body.password);

  if (!email || !z.email().safeParse(email).success) {
    throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.INVALID_EMAIL);
  }
  if (password === undefined) throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.INVALID_PASSWORD);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.PASSWORD_TOO_SHORT);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.PASSWORD_TOO_LONG);
  }

  if (isReservedAddress(email)) throw emailTaken();
  if (await context.internalAdapter.findUserByEmail(normalizeEmail(email))) throw emailTaken();

  const strength = checkPasswordStrength(password);
  if (!strength.valid) throw weakPassword(strength.suggestions);

  const name = str(body.name);
  if (name?.trim()) return;
  return {
    context: {
      body: { ...body, name: deriveName(str(body.first_name), str(body.last_name), email) },
    },
  };
}

/**
 * `/reset-password`, in the legacy order (reset_password/route.ts): the token
 * is looked up first — missing, unknown or expired is the one 400 — and only
 * then is the new password's strength checked. better-auth then consumes the
 * token atomically, so a token raced by two requests still drives one change.
 */
async function resetGuard(body: Body, query: unknown, context: HookContext) {
  const token = str(body.token) || str(asBody(query).token);
  if (!token) throw invalidResetToken();
  const verification = await context.internalAdapter.findVerificationValue(
    `reset-password:${token}`
  );
  if (!verification || verification.expiresAt < new Date()) throw invalidResetToken();

  const newPassword = str(body.newPassword);
  if (newPassword === undefined) return;
  const strength = checkPasswordStrength(newPassword);
  if (!strength.valid) throw weakPassword(strength.suggestions);
}

function invalidResetToken(): APIError {
  return new APIError('BAD_REQUEST', {
    message: INVALID_RESET_TOKEN_MESSAGE,
    code: 'INVALID_TOKEN',
  });
}

export type Auth = ReturnType<typeof createAuth>;
