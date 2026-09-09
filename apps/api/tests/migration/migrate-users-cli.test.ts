import { describe, it, expect, afterEach } from 'vitest';

// Issue #131: the CLI's pure helpers. main() is NEVER invoked here (hard constraint:
// the script is not executed in any mode); importing the module is side-effect free
// because main() is guarded on process.argv[1].
import {
  parseArgs,
  missingMongoEnv,
  databaseConfigError,
  usage,
  UsageError,
  COMMANDS,
  DEFAULT_OUTPUT_PATH,
} from '../../scripts/migrate-users/index';
import { resetEnvCache } from '@/lib/config';

describe('parseArgs', () => {
  it('parses command and every option', () => {
    expect(
      parseArgs(['migrate', '--email', 'a@example.com', '--dry-run', '--from-file', 'x.json', '--output', 'out.jsonl'])
    ).toEqual({
      command: 'migrate',
      options: { email: 'a@example.com', dryRun: true, fromFile: 'x.json', output: 'out.jsonl' },
    });
  });

  it('returns an undefined command and no options for no args', () => {
    expect(parseArgs([])).toEqual({ command: undefined, options: {} });
  });

  it('throws UsageError on an unknown flag', () => {
    expect(() => parseArgs(['migrate', '--bogus'])).toThrow(UsageError);
    expect(() => parseArgs(['migrate', '--bogus'])).toThrow('Unknown argument: --bogus');
  });

  it('treats a value-taking flag with no value as unknown', () => {
    expect(() => parseArgs(['migrate', '--email'])).toThrow(UsageError);
  });

  it('exposes the two commands and the default mapping path', () => {
    expect([...COMMANDS]).toEqual(['migrate', 'delete-readonly']);
    expect(DEFAULT_OUTPUT_PATH).toBe('tmp/migration-mapping.jsonl');
    expect(usage()).toContain('NOT FOR PRODUCTION');
    expect(usage()).toContain(DEFAULT_OUTPUT_PATH);
  });
});

describe('missingMongoEnv', () => {
  it('requires both Mongo vars for migrate without --from-file', () => {
    expect(missingMongoEnv('migrate', undefined, {})).toEqual(['MONGO_URL', 'MONGO_DB_NAME']);
    expect(missingMongoEnv('migrate', undefined, { MONGO_URL: 'mongodb://x' })).toEqual(['MONGO_DB_NAME']);
    expect(missingMongoEnv('migrate', undefined, { MONGO_URL: 'mongodb://x', MONGO_DB_NAME: 'db' })).toEqual([]);
  });

  it('requires nothing for migrate --from-file', () => {
    expect(missingMongoEnv('migrate', 'export.json', {})).toEqual([]);
  });

  it('requires nothing for delete-readonly', () => {
    expect(missingMongoEnv('delete-readonly', undefined, {})).toEqual([]);
  });

  it('treats an empty string as missing', () => {
    expect(missingMongoEnv('migrate', undefined, { MONGO_URL: '', MONGO_DB_NAME: '' })).toEqual([
      'MONGO_URL',
      'MONGO_DB_NAME',
    ]);
  });
});

describe('databaseConfigError', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  it('is null when the runtime config parses', () => {
    // The suite runs with the .env.ci placeholders loaded.
    resetEnvCache();
    expect(databaseConfigError()).toBeNull();
  });

  it('reports the Zod failure when the database URL is absent', () => {
    delete process.env['DATABASE' + '_URL'];
    resetEnvCache();
    const err = databaseConfigError();
    expect(err).not.toBeNull();
    expect(err).toContain('Environment validation failed');
    // Zod v4 reports the failing path; the variable name is what an operator greps for.
    expect(err).toContain('"DATABASE_URL"');
  });
});
