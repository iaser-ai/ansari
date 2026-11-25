/**
 * The apps/auth client: exchanges a WhatsApp user's BSUID for a JWT that apps/api accepts.
 *
 * Python counterparts: `auth_client_base.py` (the interface), `auth_client_real.py` and `auth_client_mock.py`.
 *
 * Differences from Python:
 * - `AuthClient` is an `interface`, a type with no code. Python's abstract base class (`ABC`) enforced the same promise
 *   at runtime; TypeScript checks it while compiling. `AuthClientReal implements AuthClient` makes the compiler refuse a
 *   class that misses a method.
 * - Times are milliseconds on `performance.now()`, a clock that only moves forward (Python: `time.monotonic()`).
 * - The clock, `fetch` and the settings are options rather than module globals, so a test passes its own.
 */
import { createHash } from 'node:crypto';
import type { Secret } from '../config';
import {
  AuthBadRequestError,
  AuthKeyRejectedError,
  AuthRateLimitedError,
  AuthTokenError,
  AuthUserBannedError,
} from '../errors';
import type { Logger } from '../logger';
import { describeNetworkError, discardBody, trimTrailingSlashes, type FetchLike } from './http';

/**
 * Contract (issue #329): `POST /api/whatsapp/session` with `Authorization: Bearer <key>` and `{"bsuid": ...}` answers
 * `{"token": ...}`. Errors are `{"message"}` bodies: 400 the request failed apps/auth's sanity bounds on the BSUID (a bug
 * here), 401 one identical body for every key refusal, 403 this user is banned, 429 this user's budget is spent
 * (`X-Retry-After`), 500 an outage or a permanent fault for this one user.
 */
export const SESSION_PATH = '/api/whatsapp/session';

/** The token lives 15 minutes; reuse it for a bit less so a cached one never expires mid-request. */
export const TOKEN_CACHE_SECONDS = 14 * 60;
export const TOKEN_CACHE_MAX_ENTRIES = 10_000;

/** Used when a 429 carries no usable `X-Retry-After`: assume the user's whole 15-minute window in apps/auth. */
export const DEFAULT_RETRY_AFTER_SECONDS = 15 * 60;

const REQUEST_TIMEOUT_MS = 5000;

/** Exchanges a WhatsApp user's BSUID for a JWT that apps/api accepts. */
export interface AuthClient {
  /**
   * Get a JWT for the user identified by this BSUID (never a phone number). It is sent as the bearer token on every
   * apps/api call.
   *
   * @throws {AuthTokenError} or one of its subclasses, each meaning something different (see `errors.ts`).
   */
  getToken(bsuid: string): Promise<string>;
  /** Drop this user's cached token, e.g. after apps/api refused it. */
  forget(bsuid: string): void;
}

export interface AuthClientOptions {
  /** apps/auth's base URL, no path. */
  baseUrl: string;
  /** Authenticates this service to apps/auth. */
  apiKey: Secret;
  logger: Logger;
  fetch?: FetchLike;
  /** A clock that only moves forward, in milliseconds. Only tests pass it. */
  now?: () => number;
  /** How many tokens (and cool-downs) to remember. Only tests pass it. */
  maxEntries?: number;
}

/** Python's `int(header)` for a plain whole number, else `undefined`. */
function parseWholeNumber(text: string | null): number | undefined {
  if (text === null || !/^\s*[+-]?\d+\s*$/.test(text)) return undefined;
  return Number.parseInt(text, 10);
}

/** Calls apps/auth over HTTP, authenticated with `AUTH_WHATSAPP_API_KEY`. */
export class AuthClientReal implements AuthClient {
  readonly #url: string;
  readonly #apiKey: Secret;
  readonly #logger: Logger;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #maxEntries: number;
  /** bsuid -> its token and when it stops being reused. */
  #cache = new Map<string, { token: string; expiresAt: number }>();
  /** bsuid -> when its 429 ends. */
  #cooldown = new Map<string, number>();

  constructor(options: AuthClientOptions) {
    this.#url = `${trimTrailingSlashes(options.baseUrl)}${SESSION_PATH}`;
    this.#apiKey = options.apiKey;
    this.#logger = options.logger;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => performance.now());
    this.#maxEntries = options.maxEntries ?? TOKEN_CACHE_MAX_ENTRIES;
  }

  async getToken(bsuid: string): Promise<string> {
    const now = this.#now();
    const cached = this.#cache.get(bsuid);
    if (cached && cached.expiresAt > now) return cached.token;

    // A user whose budget is spent is not asked again until it frees up: every ask would only be refused
    const until = this.#cooldown.get(bsuid);
    if (until !== undefined && until > now) {
      throw new AuthRateLimitedError('Token exchange refused: user is cooling down', Math.floor((until - now) / 1000) + 1);
    }
    this.#cooldown.delete(bsuid);

    const token = await this.#exchange(bsuid);
    this.#remember(bsuid, token);
    return token;
  }

  forget(bsuid: string): void {
    this.#cache.delete(bsuid);
  }

  #remember(bsuid: string, token: string): void {
    const now = this.#now();
    if (this.#cache.size >= this.#maxEntries) {
      this.#cache = new Map([...this.#cache].filter(([, entry]) => entry.expiresAt > now));
    }
    if (this.#cache.size < this.#maxEntries) {
      this.#cache.set(bsuid, { token, expiresAt: now + TOKEN_CACHE_SECONDS * 1000 });
    }
  }

  #startCooldown(bsuid: string, retryAfterSeconds: number): void {
    const now = this.#now();
    if (this.#cooldown.size >= this.#maxEntries) {
      this.#cooldown = new Map([...this.#cooldown].filter(([, ends]) => ends > now));
    }
    if (this.#cooldown.size < this.#maxEntries) {
      this.#cooldown.set(bsuid, now + retryAfterSeconds * 1000);
    }
  }

  static #retryAfter(response: Response): number {
    const value = parseWholeNumber(response.headers.get('X-Retry-After'));
    return value !== undefined && value > 0 ? value : DEFAULT_RETRY_AFTER_SECONDS;
  }

  async #exchange(bsuid: string): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey.reveal()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bsuid }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.#logger.error(`Network error during token exchange: ${describeNetworkError(error)}`);
      throw new AuthTokenError('Network error during token exchange', { cause: error });
    }

    const status = response.status;
    if (status !== 200) await discardBody(response);

    if (status === 400) {
      this.#logger.error('apps/auth refused the request as malformed (HTTP 400): a bug in this service');
      throw new AuthBadRequestError('Token exchange failed: HTTP 400');
    }
    if (status === 401) {
      this.#logger.error("apps/auth rejected this service's API key (HTTP 401): the key needs an operator");
      throw new AuthKeyRejectedError('Token exchange failed: HTTP 401');
    }
    if (status === 403) {
      this.#logger.warn('apps/auth says this user is banned (HTTP 403)');
      throw new AuthUserBannedError('Token exchange refused: user is banned');
    }
    if (status === 429) {
      const retryAfter = AuthClientReal.#retryAfter(response);
      this.#startCooldown(bsuid, retryAfter);
      this.#logger.warn(`apps/auth says this user's exchange budget is spent (HTTP 429), retry in ${retryAfter}s`);
      throw new AuthRateLimitedError('Token exchange refused: user budget spent', retryAfter);
    }
    if (status !== 200) {
      this.#logger.error(`apps/auth failed the token exchange: HTTP ${status}`);
      throw new AuthTokenError(`Token exchange failed: HTTP ${status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      this.#logger.error('apps/auth returned a non-JSON token response');
      throw new AuthTokenError('Invalid token response', { cause: error });
    }

    // `typeof body === 'object'` is true for null and arrays too, so both are excluded by hand
    const token = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { token?: unknown }).token : undefined;
    if (typeof token !== 'string' || token === '') {
      this.#logger.error('apps/auth token response had no token');
      throw new AuthTokenError('Token response had no token');
    }
    return token;
  }
}

/**
 * A stand-in for apps/auth that makes up tokens, for local development (`MOCK_AUTH_CLIENT`).
 * Each BSUID gets its own stable fake token, so one BSUID is one user and a new BSUID is a new user.
 * With `MOCK_AUTH_TOKEN` set, every BSUID gets that one real JWT, so a mocked sign-in can talk to a real apps/api.
 *
 * The fake token is `mock-token-` plus a hash of the BSUID. Python used a UUID; nothing compares the two.
 */
export class AuthClientMock implements AuthClient {
  readonly #fixedToken: Secret | undefined;

  constructor(options: { fixedToken?: Secret } = {}) {
    this.#fixedToken = options.fixedToken;
  }

  async getToken(bsuid: string): Promise<string> {
    if (!bsuid) throw new AuthTokenError('Missing BSUID');
    if (this.#fixedToken) return this.#fixedToken.reveal();
    return `mock-token-${createHash('sha256').update(`mock-bsuid:${bsuid}`).digest('hex').slice(0, 32)}`;
  }

  forget(): void {}
}
