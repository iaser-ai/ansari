// Relative imports, not `@/`: apps/auth's contract suite
// (apps/auth/tests/frontend-client.test.ts) runs this module against a real
// apps/auth, and that package has no `@` alias.
import { ApiError, customFetch } from '../../vendor/api-client-react/custom-fetch';
import {
  authSessionSchema,
  authStatusSchema,
  authTokenSchema,
  signOutSchema,
} from '../api/wire-schemas';

/**
 * The `apps/auth` (better-auth) client. One transport on web, iOS and
 * Android: every call goes through `customFetch` (`credentials: 'omit'`, no
 * cookies anywhere), and the session token travels as `Authorization: Bearer`.
 * The apps/api JWT is never sent here: `customFetch` attaches it only to
 * base-URL requests, and these URLs are absolute.
 *
 * - sign-in / sign-up answer with the session token in the body.
 * - `GET /api/auth/token` exchanges that session for a JWT for `apps/api`.
 * - sign-out ends the session.
 * - request-password-reset and reset-password are the two halves of a reset
 *   (`app/forgot-password.tsx`, `app/reset-password.tsx`). They need no
 *   session. The reset token is a credential: it is sent in the body and
 *   never logged.
 *
 * Every response is zod-validated. Tokens flow through here but are never
 * logged.
 */

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  registerToMailList?: boolean;
}

export interface AuthSession {
  sessionToken: string;
  firstName: string;
  lastName: string;
}

export type AuthEndpoint =
  | 'sign-in'
  | 'sign-up'
  | 'token'
  | 'sign-out'
  | 'request-password-reset'
  | 'reset-password';

/**
 * A human-readable auth failure. `status` is the HTTP status, or 0 when no
 * usable response arrived (network failure, unexpected body); `endpoint`
 * says which call failed, so a caller can tell "this password no longer
 * verifies" (401 from sign-in) from everything transient.
 */
export class AuthError extends Error {
  readonly name = 'AuthError';
  readonly status: number;
  readonly endpoint: AuthEndpoint;
  constructor(message: string, status: number, endpoint: AuthEndpoint, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.status = status;
    this.endpoint = endpoint;
  }
}

/**
 * apps/auth's answer to a reset token that is unknown, expired or already
 * used (`INVALID_RESET_TOKEN_MESSAGE` in @ansari/auth, which this app cannot
 * import). apps/auth/tests/frontend-client.test.ts pins the two equal.
 */
export const INVALID_RESET_TOKEN_MESSAGE = 'Invalid or expired reset token';

const UNREACHABLE = "Couldn't reach Ansari. Check your connection and try again.";
const UNAVAILABLE = 'Sign-in is unavailable right now. Please try again shortly.';
const TOO_MANY = 'Too many attempts. Please wait a minute and try again.';

/** better-auth's error body is `{code, message}`. */
function serverMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

function toAuthError(error: unknown, endpoint: AuthEndpoint, fallback: string): AuthError {
  if (error instanceof ApiError) {
    if (error.status === 429) return new AuthError(TOO_MANY, 429, endpoint);
    if (error.status >= 500) return new AuthError(UNAVAILABLE, error.status, endpoint);
    return new AuthError(serverMessage(error.data) ?? fallback, error.status, endpoint);
  }
  // No response (fetch threw) or a body of the wrong shape (ZodError,
  // ResponseParseError): nothing the account did, so status 0.
  return new AuthError(UNREACHABLE, 0, endpoint, error);
}

export interface AuthApiOptions {
  /** apps/auth's origin, no trailing slash. */
  baseUrl: string;
  /** The `X-Ansari-Client` id (`lib/auth/client-id.ts`). */
  clientId: string;
}

export interface AuthApi {
  signIn(email: string, password: string): Promise<AuthSession>;
  signUp(input: RegisterInput): Promise<AuthSession>;
  /** A fresh apps/api JWT for a live session. */
  mintJwt(sessionToken: string): Promise<string>;
  signOut(sessionToken: string): Promise<void>;
  /** Asks for a reset email. Answers the same whether or not the account exists. */
  requestPasswordReset(email: string): Promise<void>;
  /** Sets a new password with the emailed token. Ends every session of the account. */
  resetPassword(token: string, newPassword: string): Promise<void>;
}

export function createAuthApi({ baseUrl, clientId }: AuthApiOptions): AuthApi {
  const url = (path: string) => `${baseUrl}/api/auth${path}`;
  const headers = (sessionToken?: string): Record<string, string> => ({
    'X-Ansari-Client': clientId,
    ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
  });

  const toSession = (raw: unknown, fallback: { firstName?: string; lastName?: string } = {}) => {
    const parsed = authSessionSchema.parse(raw);
    return {
      sessionToken: parsed.token,
      firstName: parsed.user.first_name ?? fallback.firstName ?? '',
      lastName: parsed.user.last_name ?? fallback.lastName ?? '',
    };
  };

  return {
    async signIn(email, password) {
      try {
        const raw = await customFetch<unknown>(url('/sign-in/email'), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ email, password }),
        });
        return toSession(raw);
      } catch (error) {
        throw toAuthError(error, 'sign-in', 'Could not sign you in. Please try again.');
      }
    },

    async signUp(input) {
      try {
        const raw = await customFetch<unknown>(url('/sign-up/email'), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            email: input.email,
            password: input.password,
            first_name: input.firstName,
            last_name: input.lastName,
            register_to_mail_list: input.registerToMailList ?? false,
          }),
        });
        return toSession(raw, input);
      } catch (error) {
        throw toAuthError(error, 'sign-up', 'Could not create your account. Please try again.');
      }
    },

    async mintJwt(sessionToken) {
      try {
        const raw = await customFetch<unknown>(url('/token'), {
          method: 'GET',
          headers: headers(sessionToken),
        });
        return authTokenSchema.parse(raw).token;
      } catch (error) {
        throw toAuthError(error, 'token', 'Your session has ended. Please sign in again.');
      }
    },

    async signOut(sessionToken) {
      try {
        const raw = await customFetch<unknown>(url('/sign-out'), {
          method: 'POST',
          headers: headers(sessionToken),
          body: '{}',
        });
        signOutSchema.parse(raw);
      } catch (error) {
        throw toAuthError(error, 'sign-out', 'Could not sign you out.');
      }
    },

    async requestPasswordReset(email) {
      try {
        const raw = await customFetch<unknown>(url('/request-password-reset'), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ email }),
        });
        authStatusSchema.parse(raw);
      } catch (error) {
        throw toAuthError(
          error,
          'request-password-reset',
          'Could not send the reset email. Please try again.',
        );
      }
    },

    async resetPassword(token, newPassword) {
      try {
        const raw = await customFetch<unknown>(url('/reset-password'), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ token, newPassword }),
        });
        authStatusSchema.parse(raw);
      } catch (error) {
        throw toAuthError(error, 'reset-password', 'Could not reset your password. Please try again.');
      }
    },
  };
}
