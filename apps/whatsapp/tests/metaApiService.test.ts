/**
 * Sending to Meta.
 *
 * Python tests ported: `test_meta_sender_logging.py` (what is logged when Meta refuses, in every environment, and that no
 * phone number, BSUID, message text or token reaches a log outside development) and the Meta-payload cases of
 * `test_bsuid_auth_flow.py` (a phone goes in `to`, a BSUID in `recipient`).
 */
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/config';
import { MetaApiError } from '../src/errors';
import { MetaApiServiceMock, MetaApiServiceReal, metaErrorSummary } from '../src/services/metaApiService';
import { runWithRequestId } from '../src/logger';
import { capturingLogger, fakeFetch, jsonResponse, type Handler } from './helpers/network';

const BSUID = 'US.13491208655302741918';
const PHONE = '201234567899';
const MESSAGE_TEXT = 'a-very-distinctive-reply-text';
const TRACE_ID = 'Axly7O1UTgCLGu6n8EXWWTD';
const TOKEN = 'the-meta-access-token';
const API_URL = 'https://graph.facebook.com/v26.0/123456/messages';

/** What Meta sent for a recipient who was not on the test number's list. */
const META_REPLY = {
  error: {
    message: '(#131030) Recipient phone number not in allowed list',
    type: 'OAuthException',
    code: 131030,
    error_data: {
      messaging_product: 'whatsapp',
      details: 'Recipient phone number not in allowed list: Add recipient phone number to recipient list.',
    },
    fbtrace_id: TRACE_ID,
  },
};

/** A reply that echoes the recipient, which Meta's docs do not rule out. */
const ECHOING_REPLY = {
  error: {
    message: `(#131030) Recipient ${PHONE} is not allowed`,
    type: 'OAuthException',
    code: 131030,
    error_data: { messaging_product: 'whatsapp', details: `Cannot send to +${PHONE} or ${BSUID}` },
    fbtrace_id: TRACE_ID,
  },
};

type Deployment = 'development' | 'staging' | 'production';

function setup(handler: Handler, environment: Deployment = 'production') {
  const net = fakeFetch(handler);
  const log = capturingLogger();
  const reports: Array<{ error: unknown; errorType: string; context?: Record<string, unknown> }> = [];
  const service = new MetaApiServiceReal({
    apiUrl: API_URL,
    accessToken: new Secret(TOKEN),
    environment,
    logger: log.logger,
    fetch: net.fetch,
    reportError: (error, report) => reports.push({ error, ...report }),
  });
  return { service, log, reports, ...net };
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected an error, but the call succeeded');
}

const ok = () => jsonResponse(200, { messages: [{ id: 'wamid.X' }] });

describe('what is sent', () => {
  it('sends a phone number as `to`, with no `recipient`', async () => {
    const { service, calls } = setup(ok);
    await service.sendMessage(PHONE, ['hello']);
    expect(calls[0]!.json).toEqual({ messaging_product: 'whatsapp', type: 'text', text: { body: 'hello' }, to: PHONE });
  });

  it('sends a BSUID as `recipient`, with no `to`', async () => {
    const { service, calls } = setup(ok);
    await service.sendMessage(BSUID, ['hello']);
    expect(calls[0]!.json).toEqual({
      messaging_product: 'whatsapp',
      type: 'text',
      text: { body: 'hello' },
      recipient_type: 'individual',
      recipient: BSUID,
    });
  });

  it('treats only digits as a phone number', async () => {
    const { service, calls } = setup(ok);
    for (const recipient of ['+201234567899', '20123 456', 'US.123', '١٢٣']) await service.sendMessage(recipient, ['x']);
    expect(calls.map((call) => 'recipient' in (call.json as object))).toEqual([true, true, true, true]);
  });

  it('authenticates with the access token and posts to the configured URL', async () => {
    const { service, calls } = setup(ok);
    await service.sendMessage(PHONE, ['hello']);
    expect(calls[0]!.url).toBe(API_URL);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.redirect).toBe('manual');
  });

  it('sends the parts one after another, in order, each as its own message', async () => {
    const { service, calls } = setup(ok);
    await service.sendMessage(BSUID, ['one', 'two', 'three']);
    expect(calls.map((call) => (call.json as { text: { body: string } }).text.body)).toEqual(['one', 'two', 'three']);
  });

  it('splits oversized replies without breaking Unicode characters', async () => {
    const text = '🙂'.repeat(4_097);
    const { service, calls } = setup(ok);

    await service.sendMessage(BSUID, [text]);

    const sent = calls.map((call) => (call.json as { text: { body: string } }).text.body);
    expect(sent).toHaveLength(2);
    expect(sent.every((part) => [...part].length <= 4_096)).toBe(true);
    expect(sent.join('')).toBe(text);
  });

  it('rejects answers that would need more than ten messages before sending any', async () => {
    const { service, calls } = setup(ok);

    await expect(service.sendMessage(BSUID, Array.from({ length: 11 }, (_, i) => `part ${i + 1}`))).rejects.toThrow(
      '10-message WhatsApp limit',
    );
    expect(calls).toHaveLength(0);
  });

  it('stops at the first part Meta refuses, so later parts are not sent out of order', async () => {
    let n = 0;
    const { service, calls } = setup(() => (++n === 2 ? jsonResponse(400, META_REPLY) : ok()));
    expect(await thrown(service.sendMessage(BSUID, ['one', 'two', 'three']))).toBeInstanceOf(MetaApiError);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['no recipient', '', ['hello']],
    ['no parts', BSUID, []],
  ] as const)('sends nothing for %s', async (_name, recipient, parts) => {
    const { service, calls } = setup(ok);
    await service.sendMessage(recipient, [...parts]);
    expect(calls).toHaveLength(0);
  });

  it('sends the typing indicator for the message, without naming the recipient', async () => {
    const { service, calls } = setup(ok);
    await service.sendTypingIndicator(BSUID, 'wamid.HBgLMTY1');
    expect(calls[0]!.json).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.HBgLMTY1',
      typing_indicator: { type: 'text' },
    });
  });

  it.each([
    [BSUID, ''],
    ['', 'wamid.X'],
  ])('sends no typing indicator without both a recipient and a message id (%j, %j)', async (recipient, messageId) => {
    const { service, calls } = setup(ok);
    await service.sendTypingIndicator(recipient, messageId);
    expect(calls).toHaveLength(0);
  });
});

describe('interactive lists', () => {
  const LIST = {
    bodyText: 'Your current setting: 3 hours.',
    buttonText: 'Choose',
    sectionTitle: 'Chat expiry',
    rows: [
      { id: 'expiry:3:production', title: '3 hours' },
      { id: 'expiry:0:production', title: 'New chat every message' },
    ],
  };

  it('sends a phone number list as `to`, with the rows in the list', async () => {
    const { service, calls } = setup(ok);
    await service.sendInteractiveList(PHONE, LIST);
    expect(calls[0]!.json).toEqual({
      messaging_product: 'whatsapp',
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: LIST.bodyText },
        action: { button: 'Choose', sections: [{ title: 'Chat expiry', rows: LIST.rows }] },
      },
      to: PHONE,
    });
  });

  it('sends a BSUID list as `recipient`, the same as a text message', async () => {
    const { service, calls } = setup(ok);
    await service.sendInteractiveList(BSUID, LIST);
    expect(calls[0]!.json).toMatchObject({ recipient_type: 'individual', recipient: BSUID, type: 'interactive' });
    expect(calls[0]!.json).not.toHaveProperty('to');
  });

  it('a refusal from Meta is raised as a MetaApiError, like a text message', async () => {
    const { service } = setup(() => jsonResponse(400, { error: { code: 131009, message: 'bad list' } }));
    expect(await thrown(service.sendInteractiveList(PHONE, LIST))).toBeInstanceOf(MetaApiError);
  });
});
describe('when Meta refuses', () => {
  it.each(['staging', 'development', 'production'] as const)(
    'logs Meta\'s error fields in %s',
    async (deployment) => {
      const { service, log } = setup(() => jsonResponse(400, META_REPLY), deployment);
      await thrown(service.sendMessage(BSUID, [MESSAGE_TEXT]));
      expect(log.text()).toContain('code=131030');
      expect(log.text()).toContain("type='OAuthException'");
      expect(log.text()).toContain(`fbtrace_id='${TRACE_ID}'`);
      expect(log.text()).toContain('Recipient phone number not in allowed list');
    },
  );

  it.each(['staging', 'development', 'production'] as const)(
    'masks an error that echoes the recipient, in %s',
    async (deployment) => {
      const { service, log } = setup(() => jsonResponse(400, ECHOING_REPLY), deployment);
      await thrown(service.sendMessage('US.99999999999999999999', [MESSAGE_TEXT]));
      const metaLine = log.lines().find((line) => line.message.includes("Meta's reply"))!.message;
      expect(metaLine).not.toContain(PHONE);
      expect(metaLine).not.toContain(BSUID);
      expect(metaLine).toContain('code=131030');
      expect(metaLine).toContain('<phone>');
      expect(metaLine).toContain('<bsuid>');
    },
  );

  it.each(['staging', 'production'] as const)(
    'logs no phone, BSUID, message text, message id or token outside development (%s)',
    async (deployment) => {
      for (const recipient of [PHONE, BSUID]) {
        for (const method of ['message', 'typing'] as const) {
          const { service, log } = setup(() => jsonResponse(400, ECHOING_REPLY), deployment);
          await thrown(
            method === 'message'
              ? service.sendMessage(recipient, [MESSAGE_TEXT])
              : service.sendTypingIndicator(recipient, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI1RjQy'),
          );
          const text = log.text();
          expect(text).not.toContain(PHONE);
          expect(text).not.toContain(BSUID);
          expect(text).not.toContain(MESSAGE_TEXT);
          expect(text).not.toContain('wamid');
          expect(text).not.toContain(TOKEN);
        }
      }
    },
  );

  it.each(['staging', 'development', 'production'] as const)(
    'logs which keys a rejected request had, but not their values (%s)',
    async (deployment) => {
      const { service, log } = setup(() => jsonResponse(400, META_REPLY), deployment);
      await thrown(service.sendMessage(PHONE, [MESSAGE_TEXT]));
      expect(log.text()).toContain("Payload keys: ['messaging_product', 'text', 'to', 'type']");
    },
  );

  it('logs the full request body in development, but never the token', async () => {
    const { service, log } = setup(() => jsonResponse(400, META_REPLY), 'development');
    await thrown(service.sendMessage(PHONE, [MESSAGE_TEXT]));
    expect(log.text()).toContain(MESSAGE_TEXT);
    expect(log.text()).toContain(PHONE);
    expect(log.text()).toContain('Bearer ***');
    expect(log.text()).not.toContain(TOKEN);
  });

  it('logs a masked body with the safe fields readable in staging, not the full one', async () => {
    const { service, log } = setup(() => jsonResponse(400, META_REPLY), 'staging');
    await thrown(service.sendMessage(PHONE, [MESSAGE_TEXT]));
    expect(log.text()).toContain('Body with values masked');
    expect(log.text()).toContain("'type': 'text'");
    expect(log.text()).toContain('<str len=');
    expect(log.text()).toContain('Bearer ***');
    expect(log.text()).not.toContain(MESSAGE_TEXT);
  });

  it('logs no request values and no headers in production', async () => {
    const { service, log } = setup(() => jsonResponse(400, META_REPLY), 'production');
    await thrown(service.sendMessage(PHONE, [MESSAGE_TEXT]));
    expect(log.text()).not.toContain('Body');
    expect(log.text()).not.toContain('Headers');
    expect(log.text()).not.toContain('Bearer');
  });

  it('logs request details only for a 400', async () => {
    const { service, log } = setup(() => jsonResponse(403, META_REPLY), 'development');
    await thrown(service.sendMessage(BSUID, [MESSAGE_TEXT]));
    expect(log.text()).toContain('code=131030');
    expect(log.text()).not.toContain(MESSAGE_TEXT);
    expect(log.text()).not.toContain('Payload keys');
  });

  it('logs only the size of a reply that is not the standard error object', async () => {
    const { service, log } = setup(() => new Response(`upstream said ${PHONE} ${BSUID} <html>`, { status: 400 }), 'production');
    await thrown(service.sendMessage(PHONE, [MESSAGE_TEXT]));
    expect(log.text()).toContain('no standard error object');
    expect(log.text()).not.toContain(PHONE);
    expect(log.text()).not.toContain(BSUID);
  });

  it('raises a MetaApiError carrying Meta\'s status', async () => {
    const { service } = setup(() => jsonResponse(400, META_REPLY));
    const error = (await thrown(service.sendMessage(BSUID, ['x']))) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.status).toBe(400);
    expect(error.message).not.toContain(PHONE);
  });
});

describe('what the operator is told', () => {
  it('reports a 5xx, with the request id, as Meta\'s fault', async () => {
    const { service, reports } = setup(() => jsonResponse(503, {}));
    await runWithRequestId('req-77', async () => {
      await thrown(service.sendMessage(BSUID, ['x']));
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      errorType: 'meta_api_failure',
      context: { status_code: 503, endpoint: 'send_message', request_id: 'req-77' },
    });
  });

  it('names the endpoint for the typing indicator', async () => {
    const { service, reports } = setup(() => jsonResponse(500, {}));
    await thrown(service.sendTypingIndicator(BSUID, 'wamid.X'));
    expect(reports[0]!.context).toMatchObject({ endpoint: 'send_typing_indicator' });
  });

  it.each([400, 401, 403, 404, 429])('does not report a %s (our fault or the user\'s, not an outage)', async (status) => {
    const { service, reports } = setup(() => jsonResponse(status, META_REPLY));
    await thrown(service.sendMessage(BSUID, ['x']));
    expect(reports).toEqual([]);
  });

  it('puts no phone number, BSUID or message text in what it reports', async () => {
    const { service, reports } = setup(() => jsonResponse(500, ECHOING_REPLY));
    await thrown(service.sendMessage(PHONE, [MESSAGE_TEXT]));
    const reported = JSON.stringify(reports[0]!.context);
    for (const secret of [PHONE, BSUID, MESSAGE_TEXT, TOKEN]) expect(reported).not.toContain(secret);
  });
});

describe('network faults', () => {
  it('raises a MetaApiError with no status, and does not log the URL or token', async () => {
    const { service, log, reports } = setup(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ECONNRESET ${API_URL}`), { code: 'ECONNRESET' }) });
    });
    const error = (await thrown(service.sendMessage(BSUID, ['x']))) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.status).toBeUndefined();
    expect(log.text()).toContain('TypeError/ECONNRESET');
    expect(log.text()).not.toContain('graph.facebook.com');
    expect(log.text()).not.toContain(TOKEN);
    expect(reports).toEqual([]);
  });

  it('gives each request a deadline', async () => {
    const { service, calls } = setup(ok);
    await service.sendMessage(BSUID, ['x']);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('metaErrorSummary', () => {
  const summary = (body: unknown) => metaErrorSummary(jsonResponse(400, body));

  it('keeps the numeric and short text fields, masked', async () => {
    expect(await summary(META_REPLY)).toBe(
      `code=131030 type='OAuthException' fbtrace_id='${TRACE_ID}' message='(#131030) Recipient phone number not in allowed list' details='Recipient phone number not in allowed list: Add recipient phone number to recipient list.'`,
    );
  });

  it('leaves out fields that are missing or empty', async () => {
    expect(await summary({ error: { code: 1 } })).toBe('code=1');
  });

  it('does not take a boolean or a string for a number', async () => {
    expect(await summary({ error: { code: true, error_subcode: '5', message: 'm' } })).toBe("message='m'");
  });

  it('cuts long texts, counting characters not bytes', async () => {
    const out = await summary({ error: { message: '\u{1F600}'.repeat(400) } });
    expect([...out.replace(/^message='|'$/g, '')].length).toBe(300);
  });

  it.each([[null], [[1, 2]], ['text'], [{ error: 'boom' }], [{ error: [1] }]])('reports only a size for %j', async (body) => {
    expect(await summary(body)).toMatch(/^no standard error object \(\d+ bytes\)$/);
  });

  it('counts the size of a non-JSON reply in bytes', async () => {
    expect(await metaErrorSummary(new Response('\u00e9\u00e9', { status: 500 }))).toBe('no standard error object (4 bytes)');
  });
});

describe('MetaApiServiceMock', () => {
  it('records what it was asked to send and sends nothing', async () => {
    const log = capturingLogger();
    const mock = new MetaApiServiceMock({ logger: log.logger, delayMs: 0 });
    await mock.sendMessage(BSUID, ['one', 'two']);
    await mock.sendTypingIndicator(BSUID, 'wamid.X');
    expect(mock.sent).toEqual([{ recipient: BSUID, messageParts: ['one', 'two'] }]);
  });
});
