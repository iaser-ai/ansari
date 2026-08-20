/**
 * Stream heartbeat regression tests (issue #59).
 *
 * The facilitator emits nothing while Gemini is thinking or a tool round is
 * running, and api.ansari.chat is proxied through Cloudflare, which drops a
 * proxied connection after ~100s without a single byte from the origin.
 * Before the fix, both streaming chat routes only wrote bytes when the
 * facilitator yielded an event, so a long silent phase killed the stream.
 *
 * - POST /api/v2/threads/[id]/chat (SSE): a `: ping` comment heartbeat every
 *   15s for the whole life of the stream — SSE parsers ignore comment lines.
 * - POST /api/v2/threads/[id] (raw text, the frontend's actual chat path):
 *   zero-width-space heartbeats ONLY until the first real content byte, then
 *   stopped for good (a ZWSP mid-stream could break Arabic ligature shaping).
 *   Heartbeat bytes must never reach the persisted assistant message.
 *
 * Issue #64: the deployed frontend hides its thinking indicator on the first
 * received byte, so the raw route's FIRST heartbeat waits 15s (then 20s
 * cadence). Ordinary turns (first token < 15s) see zero ZWSP bytes.
 * Previous value (60s) left a fatal gap where mobile networks dropped the
 * idle TCP connection before any heartbeat, causing 15-20% of threads to
 * get no response at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { startHeartbeat } from '@/lib/streaming/heartbeat';

type FacilitatorEvent = { type: string; data: string; usage?: unknown };

const facilitator = vi.hoisted(() => ({
  script: null as null | (() => AsyncGenerator<FacilitatorEvent>),
}));

vi.mock('@/lib/facilitator/agent', () => ({
  runFacilitator: () => {
    if (!facilitator.script) throw new Error('facilitator script not set');
    return facilitator.script();
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  setTag: vi.fn(),
}));

const mockAuthenticate = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: (...a: unknown[]) => mockAuthenticate(...a),
  createErrorResponse: (detail: string, status = 400) =>
    new Response(JSON.stringify({ error: detail }), { status }),
}));

const mockFindThreadById = vi.fn();
const mockCreateMessage = vi.fn();
const mockFindMessagesByThread = vi.fn();
vi.mock('@/lib/db/threads', () => ({
  findThreadById: (...a: unknown[]) => mockFindThreadById(...a),
  createMessage: (...a: unknown[]) => mockCreateMessage(...a),
  findMessagesByThread: (...a: unknown[]) => mockFindMessagesByThread(...a),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
}));

vi.mock('@/lib/ai/thread-naming', () => ({
  maybeGenerateThreadName: vi.fn().mockResolvedValue(undefined),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ZWSP = '\u200B';
const USER = { id: 'user-1', email: 'u@example.com' };
const THREAD = { id: 'thread-1', userId: USER.id, name: null, source: 'web' };

/**
 * 40s of silence (thinking/tool round), a first text chunk, another 40s of
 * silence, a second text chunk, done. Both silent windows exceed the 15s
 * heartbeat interval; without heartbeats the wire sees zero bytes for 40s.
 */
function silentThenAnswerScript() {
  return async function* (): AsyncGenerator<FacilitatorEvent> {
    await sleep(40_000);
    yield { type: 'text', data: 'answer' };
    await sleep(40_000);
    yield { type: 'text', data: ' more' };
    yield { type: 'done', data: '', usage: undefined };
  };
}

function makePost(url: string, body: object): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Drain the response body into `chunks` as they arrive. */
function pump(response: Response, chunks: string[]): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  return (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  facilitator.script = silentThenAnswerScript();
  mockAuthenticate.mockResolvedValue({ user: USER });
  mockFindThreadById.mockResolvedValue(THREAD);
  mockCreateMessage.mockResolvedValue({ id: 'msg-1' });
  mockFindMessagesByThread.mockResolvedValue([
    { role: 'user', content: [{ type: 'text', text: 'What is sabr?' }] },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /api/v2/threads/[id]/chat SSE heartbeat (issue #59)', () => {
  it('emits `: ping` comments during silent phases, before and between events', async () => {
    const { POST } = await import('../src/app/api/v2/threads/[id]/chat/route');
    const response = await POST(
      makePost(`http://localhost/api/v2/threads/${THREAD.id}/chat`, { message: 'What is sabr?' }),
      routeContext(THREAD.id)
    );

    const chunks: string[] = [];
    const drained = pump(response, chunks);

    // 35s in: still silent — without the heartbeat, zero bytes on the wire.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(chunks.join('')).toContain(': ping\n\n');

    // Run through both text events and the second silent window.
    await vi.advanceTimersByTimeAsync(55_000);
    await drained;
    const body = chunks.join('');

    // Heartbeats arrive before the first real event...
    expect(body.indexOf(': ping')).toBeLessThan(body.indexOf('data:'));
    // ...and keep flowing during the mid-stream silent window.
    const firstText = body.indexOf('data: {"type":"text","content":"answer"}');
    const secondText = body.indexOf('data: {"type":"text","content":" more"}');
    expect(firstText).toBeGreaterThan(-1);
    expect(secondText).toBeGreaterThan(firstText);
    expect(body.indexOf(': ping', firstText)).toBeGreaterThan(firstText);
    expect(body.indexOf(': ping', firstText)).toBeLessThan(secondText);

    // SSE framing stays intact: every frame is a comment or valid JSON data.
    for (const frame of body.split('\n\n').filter(Boolean)) {
      if (frame.startsWith(':')) continue;
      expect(frame).toMatch(/^data: /);
      JSON.parse(frame.slice('data: '.length));
    }
    expect(body).toContain('data: {"type":"done"}');
  });
});

describe('POST /api/v2/threads/[id] raw-text heartbeat (issues #59/#64)', () => {
  it('sends NO ZWSP on an ordinary turn whose first token arrives before 15s', async () => {
    facilitator.script = async function* (): AsyncGenerator<FacilitatorEvent> {
      await sleep(10_000);
      yield { type: 'text', data: 'answer' };
      await sleep(5_000);
      yield { type: 'text', data: ' more' };
      yield { type: 'done', data: '', usage: undefined };
    };

    const { POST } = await import('../src/app/api/v2/threads/[id]/route');
    const response = await POST(
      makePost(`http://localhost/api/v2/threads/${THREAD.id}`, { content: 'What is sabr?' }),
      routeContext(THREAD.id)
    );

    const chunks: string[] = [];
    const drained = pump(response, chunks);

    await vi.advanceTimersByTimeAsync(20_000);
    await drained;
    expect(chunks.join('')).toBe('answer more');
  });

  it('delays the first ZWSP to 15s, then beats every 20s until the first content byte', async () => {
    facilitator.script = async function* (): AsyncGenerator<FacilitatorEvent> {
      await sleep(90_000);
      yield { type: 'text', data: 'answer' };
      await sleep(40_000);
      yield { type: 'text', data: ' more' };
      yield { type: 'done', data: '', usage: undefined };
    };

    const { POST } = await import('../src/app/api/v2/threads/[id]/route');
    const response = await POST(
      makePost(`http://localhost/api/v2/threads/${THREAD.id}`, { content: 'What is sabr?' }),
      routeContext(THREAD.id)
    );

    const chunks: string[] = [];
    const drained = pump(response, chunks);

    // 10s of silence: still nothing on the wire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chunks.join('')).toBe('');

    // 20s: the 15s initial heartbeat has fired — ZWSP(s) and nothing else.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chunks.join('')).toMatch(new RegExp(`^${ZWSP}+$`));

    // 35s: the 15s cadence produced a second beat, keeping the largest
    // wire gap far under mobile idle cutoffs.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(chunks.join('')).toBe(ZWSP + ZWSP);

    await vi.advanceTimersByTimeAsync(100_000);
    await drained;
    const body = chunks.join('');

    // Pre-content ZWSPs, then the answer with NO heartbeat bytes after the
    // first content byte — despite the 40s mid-stream silent window.
    expect(body).toMatch(new RegExp(`^${ZWSP}+answer more$`));

    const assistant = mockCreateMessage.mock.calls
      .map((c) => c[0])
      .find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant.content).toEqual([{ type: 'text', text: 'answer more' }]);
  });
});

describe('startHeartbeat', () => {
  it('fires only when idle, defers on touch, and stops for good', () => {
    const send = vi.fn();
    const hb = startHeartbeat(send, 15_000);

    vi.advanceTimersByTime(15_000);
    expect(send).toHaveBeenCalledTimes(1);

    // Activity within the interval defers the next heartbeat.
    vi.advanceTimersByTime(10_000);
    hb.touch();
    vi.advanceTimersByTime(5_000); // tick at 30s: only 5s idle
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000); // tick at 45s: 20s idle
    expect(send).toHaveBeenCalledTimes(2);

    hb.stop();
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('honors a longer initial delay before the first beat, then the regular cadence (issue #64)', () => {
    const send = vi.fn();
    const hb = startHeartbeat(send, 20_000, 60_000);

    // No beat at the regular cadence during the initial-delay window.
    vi.advanceTimersByTime(59_000);
    expect(send).not.toHaveBeenCalled();

    // First beat at 60s, then every 20s.
    vi.advanceTimersByTime(1_000);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(send).toHaveBeenCalledTimes(2);

    hb.stop();
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stops for good when stopped during the initial delay', () => {
    const send = vi.fn();
    const hb = startHeartbeat(send, 20_000, 60_000);

    vi.advanceTimersByTime(30_000);
    hb.stop();
    vi.advanceTimersByTime(120_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('stops itself when send throws (e.g. client disconnected)', () => {
    const send = vi.fn(() => {
      throw new Error('controller closed');
    });
    startHeartbeat(send, 15_000);

    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
