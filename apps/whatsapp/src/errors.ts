/**
 * Custom errors for the WhatsApp service.
 *
 * Python counterpart: `legacy/whatsapp/src/ansari_whatsapp/utils/exceptions.py`.
 *
 * `class X extends Error` is the TypeScript form of `class X(Exception)`. Each class sets
 * `name` so a log line or Sentry event shows `AuthKeyRejectedError`, not just `Error`.
 */

/** Meta sent a message payload that is missing an expected key. */
export class UnexpectedMetaPayloadError extends Error {
  override readonly name = 'UnexpectedMetaPayloadError';

  /** Phone number or BSUID we can still use to reach the sender, if the payload had one. */
  readonly replyTo: string | undefined;

  constructor(message: string, replyTo?: string) {
    super(message);
    this.replyTo = replyTo;
  }
}

/**
 * The webhook body is not the shape Meta documents (no entries, no metadata, a timestamp that is not a number...).
 * Python raised a bare `Exception` (or an IndexError/ValueError) for all of these; the HTTP layer answers them with
 * `INVALID_PAYLOAD`. Distinct from `UnexpectedMetaPayloadError`, which is the one case where the user can be told.
 */
export class InvalidMetaPayloadError extends Error {
  override readonly name = 'InvalidMetaPayloadError';
}

/** Exchanging a BSUID for a JWT with apps/auth failed (an outage, a 500, or a network fault). */
export class AuthTokenError extends Error {
  override readonly name: string = 'AuthTokenError';
}

/** apps/auth answered 400: our request was malformed, which is a bug here. Never retried. */
export class AuthBadRequestError extends AuthTokenError {
  override readonly name = 'AuthBadRequestError';
}

/** apps/auth answered 401: our API key is bad (missing, revoked, expired, out of budget). Needs an operator. */
export class AuthKeyRejectedError extends AuthTokenError {
  override readonly name = 'AuthKeyRejectedError';
}

/** apps/auth answered 403: this user is banned. */
export class AuthUserBannedError extends AuthTokenError {
  override readonly name = 'AuthUserBannedError';
}

/** apps/auth answered 429: this user's exchange budget is spent. The key is fine. */
export class AuthRateLimitedError extends AuthTokenError {
  override readonly name = 'AuthRateLimitedError';

  /** Seconds until the user's budget frees up. */
  readonly retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/** Base error for Ansari client (apps/api) failures. */
export class AnsariClientError extends Error {
  override readonly name: string = 'AnsariClientError';
}

/** apps/api answered 401: it refused this user's token (a session can end after the token was signed). */
export class ApiUnauthorizedError extends AnsariClientError {
  override readonly name = 'ApiUnauthorizedError';
}

/** Thread creation failed. */
export class ThreadCreationError extends AnsariClientError {
  override readonly name = 'ThreadCreationError';
}

/** Deleting an expired thread failed. */
export class ThreadDeletionError extends AnsariClientError {
  override readonly name = 'ThreadDeletionError';
}

/** Retrieving thread info failed. */
export class ThreadInfoError extends AnsariClientError {
  override readonly name = 'ThreadInfoError';
}

/** Message processing failed. */
export class MessageProcessingError extends AnsariClientError {
  override readonly name = 'MessageProcessingError';
}

/**
 * A call to Meta's API failed. Python let httpx's `HTTPStatusError` and `RequestError` escape from the Meta service;
 * callers only ever caught `Exception`, so one class carries both: `status` is Meta's HTTP status, or `undefined` for a
 * network fault or timeout.
 */
export class MetaApiError extends Error {
  override readonly name = 'MetaApiError';

  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
  }
}
