/**
 * What the app answers when the payload parser fails in a way it was never written to: a bug, not Meta's mistake.
 *
 * Its own file because it replaces the parser for the whole file (`vi.mock`). The real parser only ever throws its own two error
 * classes, so there is no payload that reaches this branch; the test makes one.
 *
 * Python counterpart: the `except Exception` branch of `main_webhook`, which answered `INVALID_PAYLOAD` with `str(e)`.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { startApp, webhookPayload, type TestApp } from './helpers/app';

vi.mock('../src/webhook/parseWebhook', () => ({
  parseMetaPayload: () => {
    throw new TypeError('a bug that mentions a-very-distinctive-question');
  },
}));

let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

it('answers INVALID_PAYLOAD without the error\'s own text, which could quote the payload', async () => {
  app = await startApp();

  const response = await app.post(webhookPayload());

  expect(response.status).toBe(400);
  expect(response.json.error_code).toBe('INVALID_PAYLOAD');
  expect(response.json.detail).toEqual({ error: 'Unexpected error reading the payload' });
  expect(response.text).not.toContain('a-very-distinctive-question');
});

it('reports it to the operator with the real error, so the bug can be found', async () => {
  app = await startApp();

  const response = await app.post(webhookPayload());

  expect(app.reports).toHaveLength(1);
  expect(app.reports[0]!.report.errorType).toBe('webhook_processing_failure');
  expect(app.reports[0]!.report.context).toEqual({ request_id: response.headers.get('x-request-id') });
  expect(app.reports[0]!.error).toBeInstanceOf(TypeError);
});
