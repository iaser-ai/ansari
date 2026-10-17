/**
 * The DELETE answered 401: this device's session was already dead. Either
 * the account is deleted (an earlier confirm committed and its response was
 * lost) or the session ended. The local session has been ended either way.
 */
export class AccountSessionEndedError extends Error {
  readonly name = 'AccountSessionEndedError';
  constructor() {
    super('Your session has ended.');
  }
}

/**
 * Minting a fresh JWT before the DELETE failed transiently (a 429, a 5xx, a
 * network error). Nothing was sent, so the account certainly still exists,
 * and the session is kept: the page offers a plain retry.
 */
export class AccountDeleteNotSentError extends Error {
  readonly name = 'AccountDeleteNotSentError';
  constructor() {
    super("We couldn't reach Ansari, so nothing was deleted. Try again.");
  }
}
