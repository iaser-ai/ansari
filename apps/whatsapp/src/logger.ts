/**
 * Logging for the WhatsApp service.
 *
 * Python counterpart: `legacy/whatsapp/src/ansari_whatsapp/utils/app_logger.py` (Loguru).
 *
 * Railway: outside local development, every log line is one JSON object on stdout, which
 * Railway parses into searchable fields (https://docs.railway.com/guides/logs#structured-logs).
 * To find everything one message did, search `@request_id:<id>` in the log explorer (the id
 * is also returned to the caller as the `X-Request-ID` header).
 *
 * Differences from the Python version:
 * - Loguru is a global you configure on import. Here `createLogger()` returns an object, so
 *   a test can build one with its own sinks and nothing global changes.
 * - Python's `contextvars.ContextVar` becomes Node's `AsyncLocalStorage`: a value that follows
 *   an async call chain, including work started after the HTTP response was sent.
 * - The JSON entry has no `file`, `line` or `function` keys: Loguru read them from the call
 *   stack, and Node has no cheap equivalent. The keys Railway reads (`level`, `message`) and
 *   `request_id` are unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One log call, before formatting. Python counterpart: Loguru's `record`. */
export interface LogRecord {
  level: LogLevel;
  message: string;
  requestId: string;
  error?: unknown;
}

/** The JSON object Railway expects. */
export interface LogEntry {
  level: LogLevel;
  message: string;
  request_id: string;
  exception?: { type: string | null; value: string | null };
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** LOGGING_LEVEL accepts the Python spellings too (WARNING, CRITICAL). */
const LEVEL_NAMES: Record<string, LogLevel> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO: 'info',
  SUCCESS: 'info',
  WARN: 'warn',
  WARNING: 'warn',
  ERROR: 'error',
  CRITICAL: 'error',
};

// ---------- request id (Python: request_id_var) ----------

const requestIdStorage = new AsyncLocalStorage<string>();

/** The id of the HTTP request being handled, or "none" outside a request. */
export function getRequestId(): string {
  return requestIdStorage.getStore() ?? 'none';
}

/** Run `fn` (and everything it awaits) with `requestId` attached to every log line. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}

// ---------- formatting ----------

/** JSON lines everywhere except local development and GitHub Actions. */
export function shouldUseJsonLogs(environment: string, githubActions: string | undefined): boolean {
  return environment !== 'development' && githubActions !== 'true';
}

/**
 * Turn a record into the JSON object Railway expects.
 *
 * `message` and `level` are the two keys Railway reads; every other key becomes a field you
 * can search with `@name:value`. Railway adds the timestamp itself, so none is included.
 */
export function buildLogEntry(record: LogRecord): LogEntry {
  const entry: LogEntry = {
    level: record.level,
    message: record.message,
    request_id: record.requestId,
  };
  if (record.error !== undefined && record.error !== null) {
    const err = record.error;
    entry.exception = {
      type: err instanceof Error ? err.name : typeof err,
      value: err instanceof Error ? err.message : String(err),
    };
  }
  return entry;
}

/** Format for local development: one readable line. */
export function formatReadableLine(record: LogRecord, now: Date = new Date()): string {
  const time = now.toISOString().replace('T', ' ').slice(0, 19);
  const base = `${time} | ${record.level.toUpperCase().padEnd(5)} | ${record.message}`;
  if (record.error === undefined || record.error === null) return base;
  const detail = record.error instanceof Error ? `${record.error.name}: ${record.error.message}` : String(record.error);
  return `${base} | ${detail}`;
}

// ---------- logger ----------

/** Where log lines go. Injectable so tests can capture them. */
export interface LogSinks {
  /** Railway marks everything on stderr as an error, so JSON lines must go to stdout. */
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const processSinks: LogSinks = {
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
};

export interface LoggerOptions {
  environment: string;
  /** DEBUG, INFO, WARNING or ERROR (any case). */
  level: string;
  /** Value of the GITHUB_ACTIONS environment variable. */
  githubActions?: string | undefined;
  sinks?: LogSinks;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_NAMES[options.level.toUpperCase()];
  if (threshold === undefined) {
    throw new Error(`Unknown LOGGING_LEVEL "${options.level}" (use DEBUG, INFO, WARNING or ERROR)`);
  }
  const useJson = shouldUseJsonLogs(options.environment, options.githubActions);
  const sinks = options.sinks ?? processSinks;

  function log(level: LogLevel, message: string, error?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold!]) return;
    const record: LogRecord = { level, message, requestId: getRequestId(), ...(error !== undefined ? { error } : {}) };
    if (useJson) {
      // JSON.stringify escapes an embedded newline, so the whole object stays on one line
      // (Railway cannot parse an object split over lines).
      sinks.stdout(JSON.stringify(buildLogEntry(record)) + '\n');
    } else {
      sinks.stderr(formatReadableLine(record) + '\n');
    }
  }

  return {
    debug: (message) => log('debug', message),
    info: (message) => log('info', message),
    warn: (message, error) => log('warn', message, error),
    error: (message, error) => log('error', message, error),
  };
}
