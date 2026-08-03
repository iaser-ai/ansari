import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { safeErrorMeta } from '../lib/log';

// safeErrorMeta (issue #19) is the shared sanitizer behind every route's
// catch-block logging: it must expose ONLY the error type name and, for DB
// driver errors, the SQLSTATE code — never message/query/params, any of which
// can carry user content (email, password hash, request body fields).

describe('safeErrorMeta', () => {
  it('returns the error name and string code for a driver-like error', () => {
    const err = new Error(
      'duplicate key value violates unique constraint "users_email_key": (leak@example.com)'
    ) as Error & { code: string };
    err.code = '23505';

    expect(safeErrorMeta(err)).toEqual({ name: 'Error', code: '23505' });
  });

  it('finds the SQLSTATE nested under .cause on a REAL DrizzleQueryError (how drizzle wraps pg errors)', () => {
    // drizzle-orm wraps every driver failure: the wrapper has name='Error', no
    // top-level code, and carries the pg error (with the SQLSTATE) at .cause —
    // plus the raw query text and bound params, which must never be logged.
    const pgError = new Error(
      'duplicate key value violates unique constraint "users_email_key"'
    ) as Error & { code: string };
    pgError.code = '23505';
    const wrapped = new DrizzleQueryError(
      'insert into "users" ("email", "password_hash") values ($1, $2)',
      ['leak@example.com', '$2b$12$somehash'],
      pgError
    );

    const meta = safeErrorMeta(wrapped);
    expect(meta).toEqual({ name: 'DrizzleQueryError', code: '23505' });
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('leak@example.com');
    expect(serialized).not.toContain('somehash');
    expect(serialized).not.toContain('insert into');
  });

  it('returns only the name when the error has no code', () => {
    expect(safeErrorMeta(new TypeError('boom'))).toEqual({ name: 'TypeError' });
  });

  it('omits a non-string code (e.g. numeric errno)', () => {
    const err = new Error('connect failed') as Error & { code: number };
    err.code = 111;

    expect(safeErrorMeta(err)).toEqual({ name: 'Error' });
  });

  it('handles non-Error throwables via typeof', () => {
    expect(safeErrorMeta('a thrown string')).toEqual({ name: 'string' });
    expect(safeErrorMeta(undefined)).toEqual({ name: 'undefined' });
    expect(safeErrorMeta(null)).toEqual({ name: 'object' });
  });

  it('never leaks message, query text, or params into the result', () => {
    const err = new Error('SELECT * FROM users WHERE email = $1') as Error & {
      code: string;
      detail: string;
      parameters: string[];
    };
    err.code = '23505';
    err.detail = 'Key (email)=(leak@example.com) already exists.';
    err.parameters = ['leak@example.com', '$2b$12$somehash'];

    const meta = safeErrorMeta(err);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('leak@example.com');
    expect(serialized).not.toContain('somehash');
    expect(serialized).not.toContain('SELECT');
    expect(Object.keys(meta).sort()).toEqual(['code', 'name']);
  });
});
