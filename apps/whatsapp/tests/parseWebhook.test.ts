/**
 * Reading Meta's webhook body.
 *
 * Python tests ported: the webhook cases in `test_whatsapp_service.py` (phone-hidden user, missing `from` and
 * `from_user_id`) and `test_meta_sender_logging.py` (no phone number or BSUID in log text). Those tests drove the whole
 * FastAPI app; here the parser is tested on its own, against what Python's `parse_meta_payload` returned for a table of
 * bodies (`tests/fixtures/pythonOracle.ts`). The HTTP responses built from these results are tested with the app.
 */
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/config';
import { InvalidMetaPayloadError, UnexpectedMetaPayloadError } from '../src/errors';
import { parseMetaPayload, type WebhookConfig } from '../src/webhook/parseWebhook';
import { PARSER_CASES } from './fixtures/pythonOracle';

function config(replyByPhone: boolean): WebhookConfig {
  return { META_BUSINESS_PHONE_NUMBER_ID: new Secret('123456789'), META_REPLY_BY_PHONE: replyByPhone };
}

/** Run the parser and describe the outcome in the same words the fixture uses for Python's. */
function outcome(body: unknown, replyByPhone: boolean): Record<string, unknown> {
  try {
    return { ...parseMetaPayload(body, config(replyByPhone)) };
  } catch (error) {
    if (error instanceof UnexpectedMetaPayloadError) {
      return { error: 'unexpected_payload', replyTo: error.replyTo ?? null, message: error.message };
    }
    if (error instanceof InvalidMetaPayloadError) return { error: 'invalid_payload' };
    throw error;
  }
}

describe('parseMetaPayload agrees with Python', () => {
  it.each(PARSER_CASES)('$name', ({ payload, replyByPhone, expected }) => {
    const actual = outcome(payload, replyByPhone);
    // Python also reports the class of exception it raised (Exception, IndexError, ValueError); that has no meaning here
    const wanted = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'pythonClass'));
    expect(actual).toEqual(wanted);
  });
});

const BSUID = 'US.13491208655302741918';
const PHONE = '201234567899';
const meta = { phone_number_id: '123456789', display_phone_number: '+1234567890' };
const wrap = (value: unknown) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value }] }] });

describe('identity', () => {
  it('uses the BSUID only, and never reads the phone number unless replies go to the phone', () => {
    const body = wrap({
      metadata: meta,
      messages: [{ from: PHONE, from_user_id: BSUID, id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hi' } }],
    });
    const off = parseMetaPayload(body, config(false));
    const on = parseMetaPayload(body, config(true));
    expect(off).toMatchObject({ kind: 'message', bsuid: BSUID, senderPhone: null });
    expect(on).toMatchObject({ kind: 'message', bsuid: BSUID, senderPhone: PHONE });
  });

  it('answers a phone-hidden user (no `from`) like any other', () => {
    const body = wrap({
      metadata: meta,
      contacts: [{ profile: { name: 'Test User', username: 'testuser' }, user_id: BSUID }],
      messages: [{ from_user_id: BSUID, id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'Assalamu alaikum' } }],
    });
    expect(parseMetaPayload(body, config(true))).toMatchObject({ kind: 'message', bsuid: BSUID, senderPhone: null });
  });

  it('reports a message with neither `from` nor `from_user_id` as an unexpected format', () => {
    const body = wrap({
      metadata: meta,
      contacts: [],
      messages: [{ id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hi' } }],
    });
    expect(() => parseMetaPayload(body, config(false))).toThrow(UnexpectedMetaPayloadError);
  });

  // Python passed any value along and failed later; refusing early keeps a non-text id out of the rest of the service.
  it.each([42, null, '', ['US.1'], { id: 'US.1' }])('refuses a from_user_id that is %j', (bad) => {
    const body = wrap({
      metadata: meta,
      messages: [{ from_user_id: bad, id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hi' } }],
    });
    expect(() => parseMetaPayload(body, config(false))).toThrow(UnexpectedMetaPayloadError);
  });
});

describe('what reaches the logs and error messages', () => {
  function logged(body: unknown): string {
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    try {
      parseMetaPayload(body, config(true), logger);
    } catch (error) {
      lines.push((error as Error).message);
    }
    return lines.join('\n');
  }

  const noType = wrap({
    metadata: meta,
    contacts: [{ profile: { name: 'Secret Name' }, user_id: BSUID }],
    messages: [{ from: PHONE, from_user_id: BSUID, id: 'wamid.HBgLMTY1MDM4', timestamp: '1', text: { body: 'private words' } }],
  });

  it('never contains a phone number, BSUID, message id, name or message text', () => {
    const text = logged(noType);
    for (const secret of [PHONE, BSUID, 'wamid.HBgLMTY1MDM4', 'Secret Name', 'private words']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('<str len=');
  });

  it('keeps the fields that are safe to read, such as the timestamp', () => {
    const text = logged(noType);
    expect(text).toContain('"timestamp":"1"');
    expect(text).toContain("Missing key 'type'");
  });

  it('masks an invalid body too', () => {
    const text = logged({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { note: `call ${PHONE}` } }] }] });
    expect(text).not.toContain(PHONE);
    expect(text).toContain('Missing metadata');
  });

  it('logs the type of an accepted message and nothing else about it', () => {
    const lines: string[] = [];
    parseMetaPayload(
      wrap({ metadata: meta, messages: [{ from_user_id: BSUID, id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hi' } }] }),
      config(false),
      { info: (m) => lines.push(m), error: (m) => lines.push(m) },
    );
    expect(lines).toEqual(['Received a supported whatsapp message (type: text)']);
  });
});

describe('who can be told when a message is malformed', () => {
  it('prefers the id in the message, then the contact, then nobody', () => {
    const message = { id: 'wamid.X', timestamp: '1', text: { body: 'hi' } };
    const contacts = [{ user_id: 'US.FROM.CONTACT' }];
    const replyTo = (value: unknown) => {
      try {
        parseMetaPayload(wrap(value), config(false));
      } catch (error) {
        return (error as UnexpectedMetaPayloadError).replyTo;
      }
      return 'no error';
    };
    expect(replyTo({ metadata: meta, messages: [{ ...message, from_user_id: BSUID }], contacts })).toBe(BSUID);
    expect(replyTo({ metadata: meta, messages: [message], contacts })).toBe('US.FROM.CONTACT');
    expect(replyTo({ metadata: meta, messages: [message] })).toBeUndefined();
  });
});
