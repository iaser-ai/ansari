/**
 * Railway-style JSON logs.
 *
 * Python tests ported: test_railway_logging.py. Cases that depended on Loguru's call-stack
 * fields (file, line, function) are dropped on purpose; see src/logger.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  buildLogEntry,
  createLogger,
  getRequestId,
  runWithRequestId,
  shouldUseJsonLogs,
  type LogRecord,
  type LogSinks,
} from '../src/logger';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return { level: 'info', message: 'hello', requestId: 'req-123', ...overrides };
}

function capture(): { sinks: LogSinks; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sinks: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) } };
}

describe('log entry', () => {
  it('has the message and level keys Railway reads', () => {
    const entry = buildLogEntry(record({ message: 'Created a new thread' }));
    expect(entry.message).toBe('Created a new thread');
    expect(entry.level).toBe('info');
  });

  it('carries the request id as a searchable field', () => {
    expect(buildLogEntry(record()).request_id).toBe('req-123');
  });

  it('has no user id field', () => {
    expect(buildLogEntry(record())).not.toHaveProperty('user_id');
  });

  it('includes exception details as type and value', () => {
    const entry = buildLogEntry(record({ level: 'error', error: new TypeError('bad') }));
    expect(entry.exception).toEqual({ type: 'TypeError', value: 'bad' });
  });
});

describe('JSON vs readable logs', () => {
  it.each([
    ['development', undefined, false],
    ['development', 'false', false],
    ['staging', undefined, true],
    ['production', undefined, true],
    ['staging', 'true', false], // CI never emits JSON, whatever the deployment type
    ['production', 'false', true],
  ] as const)('%s with GITHUB_ACTIONS=%s uses JSON: %s', (environment, githubActions, expected) => {
    expect(shouldUseJsonLogs(environment, githubActions)).toBe(expected);
  });

  it('writes one JSON object on one line to stdout, nothing to stderr', () => {
    const { sinks, out, err } = capture();
    createLogger({ environment: 'production', level: 'INFO', sinks }).info('line one\nline two');

    expect(err).toEqual([]); // stderr would make Railway show it as an error
    expect(out).toHaveLength(1);
    expect(out[0]!.match(/\n/g)).toHaveLength(1); // an embedded newline is escaped inside the JSON
    expect(JSON.parse(out[0]!).message).toBe('line one\nline two');
  });

  it('writes readable lines to stderr in development', () => {
    const { sinks, out, err } = capture();
    createLogger({ environment: 'development', level: 'DEBUG', sinks }).info('hello');

    expect(out).toEqual([]);
    expect(err[0]).toMatch(/\| INFO {2}\| hello\n$/);
  });
});

describe('levels', () => {
  it('drops messages below the configured level', () => {
    const { sinks, out } = capture();
    const logger = createLogger({ environment: 'production', level: 'WARNING', sinks });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(out.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('refuses an unknown level instead of logging nothing', () => {
    expect(() => createLogger({ environment: 'development', level: 'LOUD' })).toThrow(/LOGGING_LEVEL/);
  });
});

describe('request id', () => {
  it('defaults to "none" outside a request', () => {
    expect(getRequestId()).toBe('none');
  });

  it('follows the async chain, including work after an await', async () => {
    const { sinks, out } = capture();
    const logger = createLogger({ environment: 'production', level: 'INFO', sinks });

    await runWithRequestId('req-abc', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      logger.info('after the await');
    });
    logger.info('outside');

    expect(out.map((l) => JSON.parse(l).request_id)).toEqual(['req-abc', 'none']);
  });

  it('keeps two overlapping requests apart', async () => {
    const { sinks, out } = capture();
    const logger = createLogger({ environment: 'production', level: 'INFO', sinks });

    await Promise.all([
      runWithRequestId('one', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        logger.info('a');
      }),
      runWithRequestId('two', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        logger.info('b');
      }),
    ]);

    expect(out.map((l) => JSON.parse(l))).toEqual([
      { level: 'info', message: 'b', request_id: 'two' },
      { level: 'info', message: 'a', request_id: 'one' },
    ]);
  });
});
