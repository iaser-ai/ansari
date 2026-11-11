import { randomInt } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The mcp-complete key gate (#314, spec §2–§3; apps/api scenarios 1–13),
 * through the ACTUAL route against pglite. apps/auth's verify route is a
 * stubbed global fetch speaking the Phase 3 contract on the wire, so the real
 * `verifyServiceKey` and `authServiceFetch` run (neither is mocked). The
 * facilitator is a spy ("no Gemini call"), Sentry and the console are
 * captured, and every capture is scanned for key material.
 *
 * Scenario 11 (mode parsing, boot refusal) lives in config.test.ts and
 * boot-check.test.ts. Scenario 13 (a WhatsApp key) is covered at the seam:
 * apps/auth's service-verify tests prove it answers `{ valid: false }` for a
 * WhatsApp key asked for `mcp: complete`; the refusal cases here prove that
 * answer gets 401.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/db/index', () => ({
  get db() {
    return h.db;
  },
  closeDb: async () => {},
}));

const SYSTEM_USER_ID = '44444444-4444-4444-4444-444444444444';
vi.mock('@/lib/db/users', () => ({
  getOrCreateSystemUser: async () => ({
    id: '44444444-4444-4444-4444-444444444444',
    email: 'ai-skill@system.ansari.chat',
    passwordHash: 'nologin',
  }),
}));

const mockRunFacilitator = vi.fn();
vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: (...args: unknown[]) => mockRunFacilitator(...args),
}));

vi.mock('@sentry/nextjs', () => ({
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: () => '127.0.0.1',
}));

import * as Sentry from '@sentry/nextjs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { AUTH_SERVICE_TIMEOUT_MS, SERVICE_VERIFY_PATH } from '@/lib/auth-service/client';
import { resetEnvCache } from '@/lib/config';
import { GET, POST } from '../src/app/api/v2/mcp-complete/route';

const AUTH_URL = 'https://auth.mcp-gate-test.example';
const VERIFY_URL = `${AUTH_URL}${SERVICE_VERIFY_PATH}`;
const KEY_CLIENT = 'ansari-mcp-production';
const KEY_ID = '7d0c2f4e-5b1a-4c3d-9e8f-0a1b2c3d4e5f';
const PREFIX = 'ansari_mcp_staging_'; // keyPrefix('ansari-mcp', 'staging'): a shape the script can issue
const LEAK_WINDOW = 16;

/** A key in the issued shape: the public prefix and 64 random letters, fresh per run. */
function newKey(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return PREFIX + Array.from({ length: 64 }, () => letters[randomInt(letters.length)]).join('');
}
const KEY = newKey();

/** Every 16-character window of the key's random part; the public prefix is exempt. */
function keyWindows(key: string): string[] {
  const random = key.slice(PREFIX.length);
  return Array.from({ length: random.length - LEAK_WINDOW + 1 }, (_, i) => random.slice(i, i + LEAK_WINDOW));
}

function leakedWindows(text: string): string[] {
  return keyWindows(KEY).filter((window) => text.includes(window));
}

let client: PGlite;
let fetchMock: ReturnType<typeof vi.fn>;
/** Every response body the route sent, and every test's console and Sentry calls, for the leak scan. */
const responseBodies: string[] = [];
const captures: string[] = [];
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

const setTag = vi.mocked(Sentry.setTag);
const captureMessage = vi.mocked(Sentry.captureMessage);
const captureException = vi.mocked(Sentry.captureException);

async function* facilitatorAnswers(text: string) {
  yield { type: 'text' as const, data: text };
  yield { type: 'done' as const, data: '', usage: undefined };
}

function setEnv(mode?: string): void {
  vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
  vi.stubEnv('KALEMAT_API_KEY', 'placeholder');
  vi.stubEnv('USUL_API_TOKEN', 'placeholder');
  vi.stubEnv('AUTH_URL', AUTH_URL);
  vi.stubEnv('AUTH_JWT_ISSUER', AUTH_URL);
  vi.stubEnv('AUTH_JWT_AUDIENCE', 'ansari-api-gate-test');
  vi.stubEnv('AUTH_LAYER_ORIGIN', 'https://api.mcp-gate-test.example');
  if (mode === undefined) vi.stubEnv('MCP_COMPLETE_KEY_MODE', undefined);
  else vi.stubEnv('MCP_COMPLETE_KEY_MODE', mode);
  resetEnvCache();
}

/** apps/auth's verify route answers `body` with `status`. */
function authAnswers(status: number, body: unknown): void {
  fetchMock.mockImplementation(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

const VALID = { valid: true, client_id: KEY_CLIENT, key_id: KEY_ID };

beforeAll(async () => {
  client = new PGlite();
  h.db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text,
      source text DEFAULT 'web',
      client text,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role text NOT NULL,
      content jsonb NOT NULL,
      agent_name text,
      source text DEFAULT 'web',
      client text,
      input_tokens integer,
      output_tokens integer,
      thinking_tokens integer,
      total_tokens integer,
      raw_payload jsonb,
      tool_calls jsonb,
      model_provider text,
      model_id text,
      created_at timestamp with time zone DEFAULT now()
    );
    CREATE TABLE tool_call_orphans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      reason text NOT NULL,
      source text,
      client text,
      tool_calls jsonb NOT NULL,
      model_provider text,
      model_id text,
      created_at timestamp with time zone DEFAULT now()
    );
  `);
  await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
    SYSTEM_USER_ID,
    'ai-skill@system.ansari.chat',
    'nologin',
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  setEnv();
  mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfter: 0 });
  mockRunFacilitator.mockImplementation(() => facilitatorAnswers('A fine answer.'));
  fetchMock = vi.fn(async () => {
    throw new Error('no apps/auth answer was scripted for this test');
  });
  vi.stubGlobal('fetch', fetchMock);
  consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {})
  );
  await client.exec('DELETE FROM threads');
});

afterEach(() => {
  // Kept for the leak scan (scenario 12), before the spies are restored.
  captures.push(
    JSON.stringify([
      ...consoleSpies.map((spy) => spy.mock.calls),
      setTag.mock.calls,
      captureMessage.mock.calls,
      captureException.mock.calls.map(([error]) =>
        error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error
      ),
      fetchMock.mock.results.length,
    ])
  );
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// Requests and observations

interface RequestOptions {
  authorization?: string | null;
  clientHeader?: string;
  src?: string;
  body?: unknown;
  query?: string | null;
}

function postRequest(options: RequestOptions = {}): NextRequest {
  const url = new URL('http://localhost/api/v2/mcp-complete');
  if (options.src !== undefined) url.searchParams.set('src', options.src);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const authorization = options.authorization === undefined ? `Bearer ${KEY}` : options.authorization;
  if (authorization !== null) headers.authorization = authorization;
  if (options.clientHeader !== undefined) headers['X-Ansari-Client'] = options.clientHeader;
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? { messages: [{ role: 'user', content: 'What is sabr?' }] }),
  });
}

function getRequest(options: RequestOptions = {}): NextRequest {
  const url = new URL('http://localhost/api/v2/mcp-complete');
  const query = options.query === undefined ? 'What is sabr?' : options.query;
  if (query !== null) url.searchParams.set('q', query);
  if (options.src !== undefined) url.searchParams.set('src', options.src);
  const headers: Record<string, string> = {};
  const authorization = options.authorization === undefined ? `Bearer ${KEY}` : options.authorization;
  if (authorization !== null) headers.authorization = authorization;
  if (options.clientHeader !== undefined) headers['X-Ansari-Client'] = options.clientHeader;
  return new NextRequest(url, { method: 'GET', headers });
}

async function call(method: 'POST' | 'GET', options: RequestOptions = {}) {
  const response = method === 'POST' ? await POST(postRequest(options)) : await GET(getRequest(options));
  const text = await response.text();
  responseBodies.push(text);
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

async function rowCounts() {
  const count = async (table: string) =>
    (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  return {
    threads: await count('threads'),
    messages: await count('messages'),
    orphans: await count('tool_call_orphans'),
  };
}

async function expectNothingPersisted() {
  expect(await rowCounts()).toEqual({ threads: 0, messages: 0, orphans: 0 });
  expect(mockRunFacilitator).not.toHaveBeenCalled();
}

function verdictsRecorded(): string[] {
  return setTag.mock.calls.filter(([name]) => name === 'mcp_key_verdict').map(([, value]) => String(value));
}

function verdictLines(): unknown[] {
  return consoleSpies[0].mock.calls
    .filter(([line]) => line === '[ai-skill] mcp-complete key verdict')
    .map(([, fields]) => fields);
}

function messagesCaptured(): string[] {
  return captureMessage.mock.calls.map(([message]) => String(message));
}

const UNAUTHORIZED = { error: 'Unauthorized' };
const UNAVAILABLE = { error: 'Authentication service unavailable' };

// ---------------------------------------------------------------------------
// Enforce mode (the default)

describe.each(['POST', 'GET'] as const)('%s, enforce mode', (method) => {
  it('scenario 1: no Authorization → 401, no fetch, no thread, no facilitator call', async () => {
    const res = await call(method, { authorization: null });
    expect(res.status).toBe(401);
    expect(res.json()).toStrictEqual(UNAUTHORIZED);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNothingPersisted();
    expect(verdictsRecorded()).toEqual(['missing']);
    expect(verdictLines()).toEqual([{ verdict: 'missing' }]);
  });

  it.each([
    ['Basic credentials', `Basic ${Buffer.from('user:pass').toString('base64')}`],
    ['Bearer with an empty token', 'Bearer '],
    ['the bare scheme', 'Bearer'],
    ['a token containing whitespace', `Bearer ${KEY} extra`],
    ['the key with no scheme', KEY],
    ['a token longer than 256 characters', `Bearer ${'a'.repeat(257)}`],
    ['a token with a non-ASCII character', `Bearer ansari_mcp_\u00e9${'a'.repeat(10)}`],
    ['a token with DEL (0x7F)', `Bearer ansari_mcp_\x7f${'a'.repeat(10)}`],
  ])('scenario 2: %s → 401, no fetch', async (_label, authorization) => {
    const res = await call(method, { authorization });
    expect(res.status).toBe(401);
    expect(res.json()).toStrictEqual(UNAUTHORIZED);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNothingPersisted();
    expect(verdictsRecorded()).toEqual(['missing']);
  });

  it('a 256-character printable token is at the bound: it is sent to apps/auth', async () => {
    authAnswers(200, { valid: false });
    const res = await call(method, { authorization: `Bearer ${'a'.repeat(256)}` });
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(verdictsRecorded()).toEqual(['refused']);
  });

  it('scenarios 3 and 13: { valid: false } (unknown, revoked, WhatsApp, …) → the same 401, no thread, no facilitator call', async () => {
    authAnswers(200, { valid: false });
    const res = await call(method);
    expect(res.status).toBe(401);
    expect(res.json()).toStrictEqual(UNAUTHORIZED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectNothingPersisted();
    expect(verdictsRecorded()).toEqual(['refused']);
    expect(verdictLines()).toEqual([{ verdict: 'refused' }]);
  });

  it("scenario 4: a valid key → 200 with today's body, everything attributed to the key's client", async () => {
    authAnswers(200, VALID);
    const res = await call(method);
    expect(res.status).toBe(200);
    expect(res.text).toContain('A fine answer.');
    expect(res.text).toContain('askansari.ai');
    expect(mockRunFacilitator).toHaveBeenCalledTimes(1);

    // The real verifyServiceKey asked apps/auth about this key, for mcp: complete.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(VERIFY_URL);
    expect(JSON.parse(init.body as string)).toStrictEqual({ key: KEY, permissions: { mcp: ['complete'] } });

    const threads = await client.query<{ user_id: string; source: string; client: string }>(
      'SELECT user_id, source, client FROM threads'
    );
    expect(threads.rows).toEqual([{ user_id: SYSTEM_USER_ID, source: 'ai-skill', client: KEY_CLIENT }]);
    const messages = await client.query<{ source: string; client: string }>('SELECT source, client FROM messages');
    expect(messages.rows).toHaveLength(2);
    for (const row of messages.rows) expect(row).toEqual({ source: 'ai-skill', client: KEY_CLIENT });

    expect(verdictsRecorded()).toEqual(['valid']);
    expect(verdictLines()).toEqual([{ verdict: 'valid', keyId: KEY_ID }]);
    expect(setTag).toHaveBeenCalledWith('client', KEY_CLIENT);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('the scheme is case-insensitive: a lower-case bearer is verified', async () => {
    authAnswers(200, VALID);
    const res = await call(method, { authorization: `bearer ${KEY}` });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scenario 5: a forged X-Ansari-Client → the key's client, exactly one mismatch warning with both ids", async () => {
    authAnswers(200, VALID);
    const res = await call(method, { clientHeader: 'claude-skill' });
    expect(res.status).toBe(200);
    const threads = await client.query<{ client: string }>('SELECT client FROM threads');
    expect(threads.rows).toEqual([{ client: KEY_CLIENT }]);
    const messages = await client.query<{ client: string }>('SELECT DISTINCT client FROM messages');
    expect(messages.rows).toEqual([{ client: KEY_CLIENT }]);

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('mcp-complete client mismatch', {
      level: 'warning',
      tags: { client: KEY_CLIENT, header_client: 'claude-skill' },
    });
    expect(setTag).not.toHaveBeenCalledWith('client', 'claude-skill');
  });

  it('scenario 5: a malformed header → one warning tagged invalid, the raw value never sent, no invalid-header event', async () => {
    authAnswers(200, VALID);
    const raw = '<script>RAWMARKER</script>';
    const res = await call(method, { clientHeader: raw });
    expect(res.status).toBe(200);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('mcp-complete client mismatch', {
      level: 'warning',
      tags: { client: KEY_CLIENT, header_client: 'invalid' },
    });
    expect(messagesCaptured()).not.toContain('invalid X-Ansari-Client header');
    expect(JSON.stringify([captureMessage.mock.calls, setTag.mock.calls])).not.toContain('RAWMARKER');
    const threads = await client.query<{ client: string }>('SELECT client FROM threads');
    expect(threads.rows).toEqual([{ client: KEY_CLIENT }]);
  });

  it('scenario 5: a matching header (any case) → no event', async () => {
    authAnswers(200, VALID);
    const res = await call(method, { clientHeader: ' Ansari-MCP-Production ' });
    expect(res.status).toBe(200);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("scenario 6: ?src=evil → the key's client, no event", async () => {
    authAnswers(200, VALID);
    const res = await call(method, { src: 'evil' });
    expect(res.status).toBe(200);
    const threads = await client.query<{ client: string }>('SELECT client FROM threads');
    expect(threads.rows).toEqual([{ client: KEY_CLIENT }]);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalledWith('client', 'evil');
  });

  it.each([
    ['a 500', 500, { message: 'Internal error' }],
    ['a 429', 429, { message: 'Too many requests' }],
    ['a 200 that is not JSON', 200, '<html>proxy error</html>'],
    ['a 200 of the wrong shape', 200, { ok: true }],
    ['valid: true missing key_id', 200, { valid: true, client_id: KEY_CLIENT }],
    ['valid: true missing client_id', 200, { valid: true, key_id: KEY_ID }],
    ['valid: true with an off-pattern client_id', 200, { valid: true, client_id: 'claude-skill', key_id: KEY_ID }],
    ['a refusal carrying an extra field', 200, { valid: false, reason: 'revoked' }],
  ])('scenario 7: %s → 503, no thread, no facilitator call', async (_label, status, body) => {
    authAnswers(status, body);
    const res = await call(method);
    expect(res.status).toBe(503);
    expect(res.json()).toStrictEqual(UNAVAILABLE);
    await expectNothingPersisted();
    expect(verdictsRecorded()).toEqual(['unverified']);
    expect(consoleSpies[1]).toHaveBeenCalledWith('[ai-skill] mcp-complete key verify unavailable', { status });
    // Enforce mode fails closed quietly: the warning is log-only's.
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('scenario 7: a network error → 503, the status null in the warning', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await call(method);
    expect(res.status).toBe(503);
    expect(res.json()).toStrictEqual(UNAVAILABLE);
    await expectNothingPersisted();
    expect(consoleSpies[1]).toHaveBeenCalledWith('[ai-skill] mcp-complete key verify unavailable', { status: null });
  });

  it(`scenario 7: apps/auth slower than ${AUTH_SERVICE_TIMEOUT_MS} ms → 503 at the timeout, not before`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Node's AbortSignal.timeout runs on an internal timer fake timers cannot
    // drive, so stand in one built on setTimeout and check the delay it is given.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    fetchMock.mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );

    let settled = false;
    const pending = call(method).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(AUTH_SERVICE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    vi.useRealTimers();

    expect(res.status).toBe(503);
    expect(res.json()).toStrictEqual(UNAVAILABLE);
    expect(timeout).toHaveBeenCalledWith(AUTH_SERVICE_TIMEOUT_MS);
    await expectNothingPersisted();
  });

  it('scenario 9: the per-IP cap answers 429 before any verify', async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 17 });
    authAnswers(200, VALID);
    const response = method === 'POST' ? await POST(postRequest()) : await GET(getRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNothingPersisted();
  });

  it('an error other than apps/auth being unavailable falls into the route catch (500) and leaves no thread', async () => {
    vi.stubEnv('AUTH_URL', '');
    resetEnvCache();
    const res = await call(method);
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    await expectNothingPersisted();
  });
});

describe('scenario 8: the key is checked before the body', () => {
  it('a valid key with an invalid POST body → 400', async () => {
    authAnswers(200, VALID);
    const res = await call('POST', { body: { messages: [] } });
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectNothingPersisted();
  });

  it('a valid key with no ?q= → 400', async () => {
    authAnswers(200, VALID);
    const res = await call('GET', { query: null });
    expect(res.status).toBe(400);
    await expectNothingPersisted();
  });

  it('no key with an invalid POST body → 401 (the body is never read)', async () => {
    const request = postRequest({ authorization: null, body: { messages: [] } });
    const read = vi.spyOn(request, 'json');
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual(UNAUTHORIZED);
    expect(read).not.toHaveBeenCalled();
  });

  it('no key with no ?q= → 401', async () => {
    const res = await call('GET', { authorization: null, query: null });
    expect(res.status).toBe(401);
    expect(res.json()).toStrictEqual(UNAUTHORIZED);
  });
});

// ---------------------------------------------------------------------------
// Log-only mode (the rollout week)

describe.each(['POST', 'GET'] as const)('%s, log-only mode (scenario 10)', (method) => {
  beforeEach(() => {
    setEnv('log-only');
  });

  it('missing → served 200, verdict recorded, attributed by the header as today', async () => {
    const res = await call(method, { authorization: null, clientHeader: 'muslimpedia' });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verdictsRecorded()).toEqual(['missing']);
    expect(verdictLines()).toEqual([{ verdict: 'missing' }]);
    const threads = await client.query<{ client: string | null }>('SELECT client FROM threads');
    expect(threads.rows).toEqual([{ client: 'muslimpedia' }]);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('missing with ?src= → attributed by ?src= as today', async () => {
    const res = await call(method, { authorization: null, src: 'jbprompt' });
    expect(res.status).toBe(200);
    const threads = await client.query<{ client: string | null }>('SELECT client FROM threads');
    expect(threads.rows).toEqual([{ client: 'jbprompt' }]);
  });

  it('refused → served 200, verdict recorded, no warning', async () => {
    authAnswers(200, { valid: false });
    const res = await call(method);
    expect(res.status).toBe(200);
    expect(verdictsRecorded()).toEqual(['refused']);
    expect(verdictLines()).toEqual([{ verdict: 'refused' }]);
    const threads = await client.query<{ client: string | null }>('SELECT client FROM threads');
    expect(threads.rows).toEqual([{ client: null }]);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500', () => authAnswers(500, { message: 'Internal error' }), 500],
    ['a network error', () => fetchMock.mockRejectedValue(new TypeError('fetch failed')), null],
  ])('unverified (%s) → served 200, verdict recorded, one Sentry warning', async (_label, script, status) => {
    script();
    const res = await call(method);
    expect(res.status).toBe(200);
    expect(mockRunFacilitator).toHaveBeenCalledTimes(1);
    expect(verdictsRecorded()).toEqual(['unverified']);
    expect(verdictLines()).toEqual([{ verdict: 'unverified' }]);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('mcp-complete key unverified (log-only)', {
      level: 'warning',
      tags: { mcp_key_verdict: 'unverified' },
      extra: { status },
    });
  });

  it("valid → served, attributed by the key, a forged header still one mismatch warning", async () => {
    authAnswers(200, VALID);
    const res = await call(method, { clientHeader: 'claude-skill', src: 'evil' });
    expect(res.status).toBe(200);
    expect(verdictsRecorded()).toEqual(['valid']);
    expect(verdictLines()).toEqual([{ verdict: 'valid', keyId: KEY_ID }]);
    const threads = await client.query<{ client: string }>('SELECT client FROM threads');
    expect(threads.rows).toEqual([{ client: KEY_CLIENT }]);
    expect(messagesCaptured()).toEqual(['mcp-complete client mismatch']);
  });
});

describe('mode', () => {
  it('MCP_COMPLETE_KEY_MODE=enforce enforces like the default', async () => {
    setEnv('enforce');
    const res = await call('POST', { authorization: null });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: no key material anywhere. Runs last, over every capture above.

describe('scenario 12: the leak scan', () => {
  it('negative control: the scan finds a window of the key in a known-bad line', () => {
    const badLine = `verify failed for ${KEY.slice(0, PREFIX.length + 20)}`;
    expect(leakedWindows(badLine).length).toBeGreaterThan(0);
    expect(leakedWindows(KEY)).toHaveLength(64 - LEAK_WINDOW + 1);
  });

  it('near miss: the bare public prefix, and a 15-character fragment, are not a leak', () => {
    expect(leakedWindows(`${PREFIX}… key prefix`)).toEqual([]);
    expect(leakedWindows(KEY.slice(PREFIX.length, PREFIX.length + LEAK_WINDOW - 1))).toEqual([]);
  });

  it.each(['POST', 'GET'] as const)('%s: every verdict, in both modes, captures no key material', async (method) => {
    const scripts: Array<[string | undefined, () => void]> = [
      [undefined, () => authAnswers(200, VALID)],
      [undefined, () => authAnswers(200, { valid: false })],
      [undefined, () => authAnswers(500, { message: 'Internal error' })],
      [undefined, () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
      ['log-only', () => authAnswers(200, { valid: false })],
      ['log-only', () => authAnswers(500, { message: 'Internal error' })],
    ];
    for (const [mode, script] of scripts) {
      setEnv(mode);
      script();
      await call(method, { clientHeader: 'claude-skill' });
    }
    // The request reached apps/auth (so the key was in play) on every run.
    expect(fetchMock).toHaveBeenCalledTimes(scripts.length);
  });

  it('the scan over every console line, Sentry call and response body in this file finds nothing', () => {
    const text = [...captures, ...responseBodies].join('\n');
    expect(captures.length).toBeGreaterThan(60);
    expect(responseBodies.length).toBeGreaterThan(40);
    expect(leakedWindows(text)).toEqual([]);
  });
});
