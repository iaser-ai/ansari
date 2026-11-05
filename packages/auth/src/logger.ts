// Better Auth's logger, redacted (spec 329). Better Auth and its plugins log
// caught errors as they are: the api-key plugin, for one, logs every failed
// verification's error object, a raw driver error included when the database
// fails. A driver error's message can carry query parameters and user content,
// so the repo rule (log only `{name, code}`) is applied to every Error argument
// here. Nothing else changes: the level, the message and every other argument
// survive, so the logger is redacted, never silenced.
//
// Messages are not rewritten. The better-auth paths this service runs pass
// errors as arguments; the few that interpolate an error into the message
// string (OAuth discovery, token introspection) are not configured here.

export type BetterAuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type RedactedError = { name: string; code?: unknown };

/** `{name, code}` for an Error (the code from the error or its cause), as account.ts logs. */
export function redactError(err: Error): RedactedError {
  const own = (err as { code?: unknown }).code;
  const cause = (err.cause as { code?: unknown } | undefined)?.code;
  const code = own ?? cause;
  return code === undefined ? { name: err.name } : { name: err.name, code };
}

/** Every Error argument reduced to `{name, code}`; everything else unchanged. */
export function redactLogArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => (arg instanceof Error ? redactError(arg) : arg));
}

const WRITERS: Record<BetterAuthLogLevel, (...args: unknown[]) => void> = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/** The `logger.log` handed to betterAuth(): writes through console at the matching level. */
export function logBetterAuth(level: BetterAuthLogLevel, message: string, ...args: unknown[]): void {
  WRITERS[level](`[Better Auth] ${level.toUpperCase()}: ${message}`, ...redactLogArgs(args));
}
