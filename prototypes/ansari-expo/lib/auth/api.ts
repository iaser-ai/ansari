import { customFetch, ApiError } from '@/vendor/api-client-react/custom-fetch';
import {
  loginResponseSchema,
  refreshResponseSchema,
  registerResponseSchema,
  messageResponseSchema,
} from '@/lib/api/wire-schemas';

/**
 * Auth endpoint clients for `apps/api` `/api/v2/users/*`. These use `customFetch`
 * directly (base URL + bearer attach) and deliberately BYPASS the refresh-on-401
 * wrapper — refresh must never recurse into itself. Every response is
 * zod-validated; a bad shape throws.
 *
 * Tokens flow through here but are never logged.
 */

export interface Credentials {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends Credentials {
  firstName: string;
  lastName: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  registerToMailList?: boolean;
}

/** A human-readable auth failure carrying the HTTP status for the UI. */
export class AuthError extends Error {
  readonly name = 'AuthError';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function toAuthError(error: unknown, fallback: string): AuthError {
  if (error instanceof ApiError) {
    const detail =
      error.data && typeof error.data === 'object' && 'detail' in error.data
        ? String((error.data as { detail: unknown }).detail)
        : undefined;
    return new AuthError(detail || fallback, error.status);
  }
  throw error; // non-HTTP errors (incl. ZodError) propagate unchanged
}

export async function registerRequest(input: RegisterInput): Promise<Credentials> {
  try {
    const raw = await customFetch<unknown>('/api/v2/users/register', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        first_name: input.firstName,
        last_name: input.lastName,
        register_to_mail_list: input.registerToMailList ?? false,
      }),
    });
    const parsed = registerResponseSchema.parse(raw);
    return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token };
  } catch (error) {
    throw toAuthError(error, 'Could not create your account. Please try again.');
  }
}

export async function loginRequest(
  email: string,
  password: string,
): Promise<LoginResult> {
  try {
    const raw = await customFetch<unknown>('/api/v2/users/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    const parsed = loginResponseSchema.parse(raw);
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      firstName: parsed.first_name,
      lastName: parsed.last_name,
    };
  } catch (error) {
    throw toAuthError(error, 'Could not sign you in. Please try again.');
  }
}

export async function refreshRequest(refreshToken: string): Promise<Credentials> {
  const raw = await customFetch<unknown>('/api/v2/users/refresh_token', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const parsed = refreshResponseSchema.parse(raw);
  return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token };
}

export async function logoutRequest(): Promise<void> {
  const raw = await customFetch<unknown>('/api/v2/users/logout', {
    method: 'POST',
  });
  messageResponseSchema.parse(raw);
}
