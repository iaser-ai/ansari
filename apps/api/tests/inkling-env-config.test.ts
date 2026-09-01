import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * End-to-end env → config → request tests for the Inkling client (issue #90).
 *
 * Unlike inkling-client.test.ts (which mocks `@/lib/config`), these tests run
 * the REAL config module against a controlled `process.env`, so they pin the
 * whole chain the staging LoRA rollout depends on:
 *  - with INKLING_MODEL / INKLING_MAX_TOKENS unset, the outgoing request body
 *    is byte-identical to the previously hardcoded values;
 *  - setting the env vars changes exactly the `model` / `max_tokens` fields.
 */

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { resetEnvCache } from '@/lib/config';
import { streamInkling } from '../lib/ai/inkling-client';

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  KALEMAT_API_KEY: 'placeholder-key',
  USUL_API_TOKEN: 'placeholder-token',
  TINKER_API_KEY: 'test-tinker-key',
};

const fetchMock = vi.fn();

function sseResponse(): Response {
  const body = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function requestBodyFor(message: string): Promise<string> {
  fetchMock.mockResolvedValue(sseResponse());
  const events = streamInkling(message);
  // Drain the stream — only the captured request matters here.
  let step = await events.next();
  while (!step.done) step = await events.next();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0][1].body as string;
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  delete process.env.INKLING_MODEL;
  delete process.env.INKLING_MAX_TOKENS;
  resetEnvCache();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = savedEnv;
  resetEnvCache();
  vi.unstubAllGlobals();
});

describe('Inkling env configuration (issue #90)', () => {
  it('with no env vars set, the request body is byte-identical to the old hardcoded one', async () => {
    const body = await requestBodyFor('hello');
    // Exact serialized form, not just field-wise equality: the acceptance
    // criterion is that unset vars produce byte-identical requests to the
    // pre-#90 constants (model thinkingmachines/Inkling, max_tokens 8192).
    expect(body).toBe(
      JSON.stringify({
        model: 'thinkingmachines/Inkling',
        max_tokens: 8192,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hello' }],
      })
    );
  });

  it('INKLING_MODEL env var flows through config to the request model field', async () => {
    process.env.INKLING_MODEL =
      'tinker://ac84a01f-1cbb-55b0-80f4-f9f2b6e3df99:train:0/sampler_weights/final';
    resetEnvCache();

    const body = JSON.parse(await requestBodyFor('hello'));
    expect(body.model).toBe(
      'tinker://ac84a01f-1cbb-55b0-80f4-f9f2b6e3df99:train:0/sampler_weights/final'
    );
    // Untouched by the model override.
    expect(body.max_tokens).toBe(8192);
  });

  it('INKLING_MAX_TOKENS env var flows through config to the request max_tokens field', async () => {
    process.env.INKLING_MAX_TOKENS = '16384';
    resetEnvCache();

    const body = JSON.parse(await requestBodyFor('hello'));
    expect(body.max_tokens).toBe(16384);
    expect(body.model).toBe('thinkingmachines/Inkling');
  });

  it('an out-of-window INKLING_MAX_TOKENS fails loudly when the client reads config', async () => {
    process.env.INKLING_MAX_TOKENS = '4096';
    resetEnvCache();

    const events = streamInkling('hello');
    await expect(events.next()).rejects.toThrow(/8192-16384/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
