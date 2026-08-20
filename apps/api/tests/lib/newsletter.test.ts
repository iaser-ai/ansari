import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TEST_MARKETMAKER_URL = 'https://newsletter.example.com/api/newsletter/subscribe';

describe('subscribeToNewsletter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.MARKETMAKER_URL = TEST_MARKETMAKER_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MARKETMAKER_URL;
  });

  it('skips (success, no fetch) when MARKETMAKER_URL is unset', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');
    delete process.env.MARKETMAKER_URL;

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await subscribeToNewsletter('test@example.com', 'John', 'Doe');

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends correct payload to Marketmaker API', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }) as unknown as typeof fetch;

    const result = await subscribeToNewsletter('test@example.com', 'John', 'Doe');

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      TEST_MARKETMAKER_URL,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          name: 'John Doe',
          projectSlug: 'ansari',
          interests: ['islamic'],
        }),
      }),
    );
  });

  it('constructs name from firstName only when lastName is null', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    await subscribeToNewsletter('test@example.com', 'John', null);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.name).toBe('John');
  });

  it('constructs empty name when both are null', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    await subscribeToNewsletter('test@example.com', null, null);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.name).toBe('');
  });

  it('returns error on HTTP failure', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limit exceeded'),
    }) as unknown as typeof fetch;

    const result = await subscribeToNewsletter('test@example.com', 'John', 'Doe');

    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
  });

  it('returns error on network failure', async () => {
    const { subscribeToNewsletter } = await import('../../lib/newsletter');

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

    const result = await subscribeToNewsletter('test@example.com', 'John', 'Doe');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('createThrottledSubscriber', () => {
  beforeEach(() => {
    process.env.MARKETMAKER_URL = TEST_MARKETMAKER_URL;
  });

  afterEach(() => {
    delete process.env.MARKETMAKER_URL;
  });

  it('enforces minimum interval between calls', async () => {
    const { createThrottledSubscriber } = await import('../../lib/newsletter');

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    // 60 req/min = 1 sec interval. Use high rate for fast test.
    const throttled = createThrottledSubscriber(600); // 100ms interval

    const start = Date.now();
    await throttled('a@test.com', null, null);
    await throttled('b@test.com', null, null);
    const elapsed = Date.now() - start;

    // Should take at least ~100ms due to throttle
    expect(elapsed).toBeGreaterThanOrEqual(80); // Allow some timing slack
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
