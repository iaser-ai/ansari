/**
 * The HTTP app: what Meta sees when it calls the service.
 *
 * Python tests ported (all through a real listening server and `fetch`, where Python used `TestClient`):
 * - `test_whatsapp_service.py`: health, the handshake, a basic webhook, missing and wrong signatures, a phone-hidden user,
 *   a message with neither `from` nor `from_user_id`.
 * - `test_environment_behaviour.py`: a signed body that is not JSON is a 400, the handshake accepts the right token and refuses
 *   others (a non-ASCII token included), maintenance mode, the staging `!s ` filter, an unsupported type.
 * - `test_bsuid_auth_flow.py`: the webhook flow (who is signed in, who is replied to), and that no log line holds a phone number,
 *   BSUID, message text or the verify token.
 *
 * New here, because Express differs from FastAPI: the 200 is observed while slow background work is still running (the plan's
 * acknowledgment test), a failing background task is reported, and the signature is checked before the body is parsed.
 *
 * Meta's webhook statuses only show with `ALWAYS_RETURN_OK_TO_META=false`, which is how these tests run unless stated.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WEBHOOK_PATH } from '../src/app';
import { AuthTokenError, MetaApiError } from '../src/errors';
import { AnsariClientMock, type AnsariClient } from '../src/services/ansariClient';
import { AuthClientMock, type AuthClient } from '../src/services/authClient';
import type { MetaApiService } from '../src/services/metaApiService';
import { FIXED_NOW_UNIX } from './fixtures/pythonOracle';
import { capturingLogger } from './helpers/network';
import {
  APP_SECRET,
  BSUID,
  PHONE,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  messageOf,
  sign,
  startApp,
  webhookPayload,
  type TestApp,
} from './helpers/app';

let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function started(options: Parameters<typeof startApp>[0] = {}): Promise<TestApp> {
  app = await startApp(options);
  return app;
}

function handshake(t: TestApp, query: Record<string, string>) {
  return fetch(`${t.url}${WEBHOOK_PATH}?${new URLSearchParams(query)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
describe('health', () => {
  it('answers GET / with ok', async () => {
    const t = await started();
    const response = await fetch(`${t.url}/`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', message: 'Ansari WhatsApp service is running' });
  });

  it('does not say what it runs on', async () => {
    const t = await started();
    expect((await fetch(`${t.url}/`)).headers.get('x-powered-by')).toBeNull();
  });
});

describe('request ids', () => {
  it('gives each response its own id', async () => {
    const t = await started();
    const first = (await fetch(`${t.url}/`)).headers.get('x-request-id');
    const second = (await fetch(`${t.url}/`)).headers.get('x-request-id');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it('ignores an id the caller supplies, since it would go into the logs unchecked', async () => {
    const t = await started();
    const response = await fetch(`${t.url}/`, { headers: { 'X-Request-ID': 'attacker-INJECTED' } });
    expect(response.headers.get('x-request-id')).not.toContain('INJECTED');
    expect(t.log.text()).not.toContain('INJECTED');
  });

  it('puts the response id on that request\'s log lines', async () => {
    const t = await started();
    const id = (await fetch(`${t.url}/`)).headers.get('x-request-id');
    const lines = t.log.lines().filter((line) => line.message === 'Health check endpoint called');
    expect(lines).toHaveLength(1);
    expect((lines[0] as unknown as { request_id: string }).request_id).toBe(id);
  });

  it('keeps the request id on the lines the background work writes after the reply', async () => {
    const t = await started();
    const response = await t.post(webhookPayload());
    await t.settle();
    const id = response.headers.get('x-request-id');
    const backgroundLine = t.log.lines().find((line) => line.message.startsWith('Authenticated whatsapp user'));
    expect((backgroundLine as unknown as { request_id: string }).request_id).toBe(id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the verification handshake', () => {
  it('echoes the challenge for the right token', async () => {
    const t = await started();
    const response = await handshake(t, { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abc123');
  });

  it('answers as html, as Meta\'s own sample and the Python service did', async () => {
    const t = await started();
    const response = await handshake(t, { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' });
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it.each([VERIFY_TOKEN + 'x', VERIFY_TOKEN.slice(0, -1), 'wrong', 't\u00e9st', '\u0645\u0631\u062d\u0628\u0627'])(
    'refuses the token %j with a 403, not a crash',
    async (token) => {
      const t = await started();
      const response = await handshake(t, { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': 'abc123' });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ detail: 'Forbidden' });
    },
  );

  it('refuses the right token with a mode other than subscribe', async () => {
    const t = await started();
    const response = await handshake(t, { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' });
    expect(response.status).toBe(403);
  });

  it.each([
    [{}],
    [{ 'hub.mode': 'subscribe' }],
    [{ 'hub.verify_token': VERIFY_TOKEN }],
    [{ 'hub.mode': '', 'hub.verify_token': VERIFY_TOKEN }],
    [{ 'hub.mode': 'subscribe', 'hub.verify_token': '' }],
  ])('answers 400 when the mode or the token is missing: %j', async (query) => {
    const t = await started();
    expect((await handshake(t, query)).status).toBe(400);
  });

  it('answers an empty challenge when Meta sends none, as Python did', async () => {
    const t = await started();
    const response = await handshake(t, { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('uses the last value when a parameter is repeated, as Starlette did', async () => {
    const t = await started();
    const response = await fetch(
      `${t.url}${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=wrong&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=c1`,
    );
    expect(await response.text()).toBe('c1');
  });

  it('never writes the right token, or a wrong one, to the logs', async () => {
    const t = await started();
    await handshake(t, { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'c1' });
    await handshake(t, { 'hub.mode': 'subscribe', 'hub.verify_token': 'a-wrong-token-value', 'hub.challenge': 'c2' });
    const text = t.log.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(VERIFY_TOKEN);
    expect(text).not.toContain('a-wrong-token-value');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the signature', () => {
  it('rejects a webhook with no signature header', async () => {
    const t = await started();
    const response = await t.post(webhookPayload(), { secret: false });
    expect(response.status).toBe(403);
    expect(response.json).toEqual({ detail: 'Invalid signature' });
    expect(response.headers.get('www-authenticate')).toBe('HMAC-SHA256');
  });

  it('rejects a webhook signed with the wrong secret', async () => {
    const t = await started();
    expect((await t.post(webhookPayload(), { secret: 'not-the-app-secret' })).status).toBe(403);
  });

  it.each(['', 'sha256=', 'sha1=abcd', 'abcd', 'SHA256=abcd', 'sha256=zzzz', 'sha256= '])('rejects the header %j', async (signature) => {
    const t = await started();
    expect((await t.post(webhookPayload(), { signature })).status).toBe(403);
  });

  it('rejects the right digest in upper case, as Python did', async () => {
    const t = await started();
    const body = JSON.stringify(webhookPayload());
    const upper = `sha256=${sign(body).slice('sha256='.length).toUpperCase()}`;
    expect((await t.post(null, { raw: body, signature: upper })).status).toBe(403);
  });

  it('rejects a signature made for a different body', async () => {
    const t = await started();
    const body = JSON.stringify(webhookPayload());
    const other = JSON.stringify(webhookPayload({ id: 'wamid.OTHER' }));
    expect((await t.post(null, { raw: body, signature: sign(other) })).status).toBe(403);
  });

  it('checks the exact bytes: the same JSON with different spacing no longer matches', async () => {
    const t = await started();
    const compact = JSON.stringify(webhookPayload());
    const spaced = JSON.stringify(webhookPayload(), null, 2);
    expect((await t.post(null, { raw: spaced, signature: sign(compact) })).status).toBe(403);
    expect((await t.post(null, { raw: spaced })).status).toBe(200);
  });

  it('accepts a body with non-ASCII text signed over its UTF-8 bytes', async () => {
    const t = await started();
    const body = webhookPayload({ text: { body: '!d \u0645\u0631\u062d\u0628\u0627 \u{1F600}' } });
    expect((await t.post(body)).status).toBe(200);
  });

  it('answers 403 before looking at the body, so an unsigned caller cannot tell good JSON from bad', async () => {
    const t = await started();
    const good = await t.post(null, { raw: '{}', secret: false });
    const bad = await t.post(null, { raw: 'this is not json', secret: false });
    expect([good.status, bad.status]).toEqual([403, 403]);
    expect(good.text).toBe(bad.text);
  });

  it('checks the signature even when the content type is not JSON, since Meta\'s is the only thing that vouches for the bytes', async () => {
    const t = await started();
    const body = JSON.stringify(webhookPayload());
    expect((await t.post(null, { raw: body, contentType: 'text/plain', secret: false })).status).toBe(403);
    expect((await t.post(null, { raw: body, contentType: 'text/plain' })).status).toBe(200);
    expect((await t.post(null, { raw: body, contentType: null })).status).toBe(200);
  });

  it('a request with no body at all is rejected for its signature, not a crash', async () => {
    const t = await started();
    const response = await fetch(`${t.url}${WEBHOOK_PATH}`, { method: 'POST' });
    expect(response.status).toBe(403);
  });

  it('refuses a body over the size limit before anything else', async () => {
    const t = await started();
    const huge = 'x'.repeat(1_200_000);
    const response = await t.post(null, { raw: huge });
    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({ success: false, error_code: 'PAYLOAD_TOO_LARGE' });
  });

  it('keeps the signature and the app secret out of the logs', async () => {
    const t = await started();
    const body = JSON.stringify(webhookPayload());
    const signature = sign(body, 'not-the-app-secret');
    await t.post(null, { raw: body, signature });
    const text = t.log.text();
    expect(text).toContain('Invalid webhook signature');
    expect(text).not.toContain(signature.slice('sha256='.length));
    expect(text).not.toContain(APP_SECRET);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('answering Meta before the work is done', () => {
  /** A Meta stand-in whose reply to the user stalls until the test releases it. */
  function stalledMeta() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const state = { sendStarted: false, sendFinished: false, typing: 0 };
    const metaApi: MetaApiService = {
      sendTypingIndicator: async () => {
        state.typing += 1;
      },
      sendInteractiveList: async () => {},
      sendMessage: async () => {
        state.sendStarted = true;
        await gate;
        state.sendFinished = true;
      },
    };
    return { metaApi, state, release: () => release() };
  }

  it('sends the 200 while the user\'s reply is still stalled', async () => {
    const stalled = stalledMeta();
    const t = await started({ metaApi: stalled.metaApi });

    const response = await t.post(webhookPayload());

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ success: true, message: 'Message processed successfully' });
    expect(stalled.state.sendFinished).toBe(false);
    expect(t.background.pending).toBe(1);

    stalled.release();
    await t.settle();
    expect(stalled.state.sendFinished).toBe(true);
    expect(t.background.pending).toBe(0);
  });

  it('answers Meta while apps/auth is still working, so a slow sign-in cannot make Meta resend', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowAuth: AuthClient = {
      getToken: async () => {
        await gate;
        return new AuthClientMock().getToken(BSUID);
      },
      forget: () => {},
    };
    const t = await started({ authClient: slowAuth });

    const response = await t.post(webhookPayload());

    expect(response.status).toBe(200);
    expect(t.replies()).toEqual([]);
    release();
    await t.settle();
    expect(t.replies()).toHaveLength(1);
  });

  it('answers Meta while apps/api is still working', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    const slowApi: AnsariClient = {
      getPreferences: (...args) => inner.getPreferences(...args),
      setPreference: (...args) => inner.setPreference(...args),
      completeChat: async (...args) => (await gate, inner.completeChat(...args)),
    };
    const t = await started({ ansariClient: slowApi });

    expect((await t.post(webhookPayload())).status).toBe(200);
    expect(t.replies()).toEqual([]);
    release();
    await t.settle();
    expect(t.replies()).toHaveLength(1);
  });

  it('answers the maintenance notice after the reply too', async () => {
    const stalled = stalledMeta();
    const t = await started({ metaApi: stalled.metaApi, env: { WA_MAINTENANCE_MODE: 'true' } });
    const response = await t.post(webhookPayload());
    expect(response.status).toBe(503);
    expect(stalled.state.sendFinished).toBe(false);
    stalled.release();
    await t.settle();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('a message', () => {
  it('is answered, with the 200 body Meta expects', async () => {
    const t = await started();
    const response = await t.post(webhookPayload({}, {}));
    await t.settle();

    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
    expect(response.json.message).toBe('Message processed successfully');
    expect(typeof response.json.timestamp).toBe('number');
    expect(t.replies()).toHaveLength(1);
    expect(t.replies()[0]).toContain('mock AI assistant');
  });

  it('answers a phone-hidden user (a BSUID and no phone) like any other', async () => {
    const t = await started();
    const body = webhookPayload(
      { from_user_id: BSUID },
      { contacts: [{ profile: { name: 'Test User', username: 'testuser' }, user_id: BSUID }] },
    );
    const response = await t.post(body);
    await t.settle();
    expect(response.status).toBe(200);
    expect(response.json.success).toBe(true);
    expect(t.recipients()).toEqual([BSUID]);
  });

  it('replies to the BSUID even when the webhook carries a phone', async () => {
    const t = await started();
    await t.post(webhookPayload({ from: PHONE }));
    await t.settle();
    expect(new Set(t.recipients())).toEqual(new Set([BSUID]));
  });

  it('replies to the phone when META_REPLY_BY_PHONE is on', async () => {
    const t = await started({ env: { META_REPLY_BY_PHONE: 'true' } });
    await t.post(webhookPayload({ from: PHONE }));
    await t.settle();
    expect(new Set(t.recipients())).toEqual(new Set([PHONE]));
  });

  it('falls back to the BSUID when the phone is hidden and META_REPLY_BY_PHONE is on', async () => {
    const t = await started({ env: { META_REPLY_BY_PHONE: 'true' } });
    await t.post(webhookPayload());
    await t.settle();
    expect(new Set(t.recipients())).toEqual(new Set([BSUID]));
  });

  it('tells the user when signing in fails, after Meta has its 200', async () => {
    const t = await started({
      authClient: {
        getToken: async () => {
          throw new AuthTokenError('apps/auth is down');
        },
        forget: () => {},
      },
    });
    const response = await t.post(webhookPayload());
    await t.settle();
    expect(response.status).toBe(200);
    expect(t.recipients()).toEqual([BSUID]);
    expect(t.replies().join('')).toContain('sign you in');
    expect(t.reports.map((r) => r.report.errorType)).toEqual(['auth_token_failure']);
  });

  it('writes no phone number, BSUID or message text to the logs', async () => {
    const t = await started({ env: { META_REPLY_BY_PHONE: 'true' } });
    await t.post(webhookPayload({ from: PHONE, text: { body: '!d a-very-distinctive-question' } }));
    await t.settle();
    const text = t.log.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(BSUID);
    expect(text).not.toContain('a-very-distinctive-question');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('what is not a message', () => {
  it('skips a webhook meant for another business number', async () => {
    const t = await started();
    const response = await t.post(webhookPayload({}, { phoneNumberId: '999' }));
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      success: true,
      message: 'Skipping, as this webhook is not intended for our WhatsApp business number',
    });
    await t.settle();
    expect(t.replies()).toEqual([]);
  });

  it('acknowledges a delivery receipt and does nothing', async () => {
    const t = await started();
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, statuses: [{ status: 'delivered' }] } }] }],
    };
    const response = await t.post(body);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ success: true, message: 'Status message processed (ignored)', error_code: 'STATUS_MESSAGE' });
    await t.settle();
    expect(t.replies()).toEqual([]);
    expect(t.background.pending).toBe(0);
  });
});

describe('what Meta is told for each kind of message (ALWAYS_RETURN_OK_TO_META off)', () => {
  it('maintenance mode: 503 MAINTENANCE_MODE, the notice is sent and nobody is signed in', async () => {
    let exchanges = 0;
    const t = await started({
      env: { WA_MAINTENANCE_MODE: 'true' },
      authClient: {
        getToken: async () => {
          exchanges += 1;
          return 'x';
        },
        forget: () => {},
      },
    });
    const response = await t.post(webhookPayload());
    await t.settle();
    expect(response.status).toBe(503);
    expect(response.json).toMatchObject({ success: false, error_code: 'MAINTENANCE_MODE', message: 'Service under maintenance' });
    expect(t.replies().join('')).toContain('down for maintenance');
    expect(exchanges).toBe(0);
  });

  it('maintenance mode off: answered normally', async () => {
    const t = await started({ env: { WA_MAINTENANCE_MODE: 'false' } });
    const response = await t.post(webhookPayload());
    await t.settle();
    expect(response.status).toBe(200);
    expect(t.replies().join('')).toContain('mock AI assistant');
  });

  it.each(['!d what is ansari?', 'what is ansari?'])('staging message "%s": 202 DEV_FILTER and no chat call', async (text) => {
    const t = await started({ env: { ENVIRONMENT: 'staging', MOCK_ANSARI_CLIENT: undefined } });
    const response = await t.post(webhookPayload({ text: { body: text } }));
    await t.settle();
    expect(response.status).toBe(202);
    expect(response.json).toMatchObject({ success: false, error_code: 'DEV_FILTER' });
    expect(t.replies()).toEqual([]);
  });

  it('staging message with the "!s " prefix: answered', async () => {
    const t = await started({ env: { ENVIRONMENT: 'staging' } });
    const response = await t.post(webhookPayload({ text: { body: '!s what is ansari?' } }));
    await t.settle();
    expect(response.status).toBe(200);
    expect(t.replies()).toHaveLength(1);
  });

  it('production message with a prefix: 202 DEV_FILTER, nothing sent', async () => {
    const t = await started({
      env: { ENVIRONMENT: 'production', MOCK_ANSARI_CLIENT: 'false', MOCK_AUTH_CLIENT: 'false', MOCK_META_API: 'false' },
    });
    const response = await t.post(webhookPayload({ text: { body: '!s what is ansari?' } }));
    await t.settle();
    expect(response.status).toBe(202);
    expect(t.replies()).toEqual([]);
  });

  it('development message with the prefix: answered', async () => {
    const t = await started({ env: { ENVIRONMENT: 'development' } });
    const response = await t.post(webhookPayload({ text: { body: '!d what is ansari?' } }));
    await t.settle();
    expect(response.status).toBe(200);
    expect(t.replies()).toHaveLength(1);
  });

  it('a message older than the threshold: 422 MESSAGE_TOO_OLD and nothing sent', async () => {
    const t = await started();
    // Relative to the frozen clock the manager uses, not the real one (the real one moves past it)
    const old = String(FIXED_NOW_UNIX - 3 * 86400);
    const response = await t.post(webhookPayload({ timestamp: old }));
    await t.settle();
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ success: false, error_code: 'MESSAGE_TOO_OLD' });
    expect(t.replies()).toEqual([]);
  });

  // Only production answers a non-text message (prefix routing); the mocks are injected, so the MOCK_* switches stay off
  const PRODUCTION = { ENVIRONMENT: 'production', MOCK_ANSARI_CLIENT: 'false', MOCK_AUTH_CLIENT: 'false', MOCK_META_API: 'false' };

  it('an unsupported type: 415 UNSUPPORTED_MESSAGE_TYPE and the user is told', async () => {
    const t = await started({ env: PRODUCTION });
    const response = await t.post(
      webhookPayload({ type: 'image', image: { id: 'media1' }, timestamp: String(Math.floor(Date.now() / 1000)) }),
    );
    await t.settle();
    expect(response.status).toBe(415);
    expect(response.json).toMatchObject({ success: false, error_code: 'UNSUPPORTED_MESSAGE_TYPE' });
    expect(t.replies()).toEqual(["Sorry, I can't process images yet. Please send me a text message."]);
  });

  it.each(['development', 'staging'])('an unsupported type in %s is ignored: 202 DEV_FILTER and nothing sent', async (environment) => {
    const t = await started({ env: { ENVIRONMENT: environment } });
    const response = await t.post(webhookPayload({ type: 'image', image: { id: 'media1' } }));
    await t.settle();
    expect(response.status).toBe(202);
    expect(response.json).toMatchObject({ error_code: 'DEV_FILTER' });
    expect(t.replies()).toEqual([]);
  });

  // Meta sends an unsupported type (video note, poll...) as an `errors` list, not an object with a body
  it('an unsupported type in production does not crash the prefix check', async () => {
    const t = await started({ env: PRODUCTION });
    const body = webhookPayload({
      type: 'unsupported',
      errors: [{ code: 131051, title: 'Message type is not supported' }],
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    delete messageOf(body).text;
    const response = await t.post(body);
    await t.settle();
    expect(response.json.error_code).toBe('UNSUPPORTED_MESSAGE_TYPE');
  });
});

describe('with ALWAYS_RETURN_OK_TO_META on (what Meta really gets)', () => {
  it.each([
    ['maintenance mode', { WA_MAINTENANCE_MODE: 'true' }, webhookPayload(), 'MAINTENANCE_MODE'],
    ['the staging filter', { ENVIRONMENT: 'staging' }, webhookPayload({ text: { body: '!d hi' } }), 'DEV_FILTER'],
    [
      'an unsupported type',
      { ENVIRONMENT: 'production', MOCK_ANSARI_CLIENT: 'false', MOCK_AUTH_CLIENT: 'false', MOCK_META_API: 'false' },
      webhookPayload({ type: 'image', image: { id: 'm' } }),
      'UNSUPPORTED_MESSAGE_TYPE',
    ],
  ])('answers 200 for %s, and the body still says why', async (_name, env, payload, errorCode) => {
    const t = await started({ env: { ALWAYS_RETURN_OK_TO_META: 'true', ...env } });
    const response = await t.post(payload);
    await t.settle();
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ success: false, error_code: errorCode });
  });

  it('the staging filter says what Python says, so a sender knows the message is for another environment', async () => {
    const t = await started({ env: { ALWAYS_RETURN_OK_TO_META: 'true', ENVIRONMENT: 'staging' } });
    const response = await t.post(webhookPayload({ text: { body: '!d hi' } }));
    await t.settle();
    expect(response.json).toMatchObject({ message: 'Message is meant for another environment', error_code: 'DEV_FILTER' });
  });

  it('answers 200 for a body over the size limit, so Meta does not resend it', async () => {
    const t = await started({ env: { ALWAYS_RETURN_OK_TO_META: 'true' } });
    const response = await t.post(null, { raw: 'x'.repeat(1_200_000) });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ success: false, error_code: 'PAYLOAD_TOO_LARGE' });
  });

  it('answers 200 for a body that is not JSON', async () => {
    const t = await started({ env: { ALWAYS_RETURN_OK_TO_META: 'true' } });
    const response = await t.post(null, { raw: 'this is not json' });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ success: false, error_code: 'INVALID_PAYLOAD' });
  });

  it('still answers 403 for a bad signature: that is not a delivery to acknowledge', async () => {
    const t = await started({ env: { ALWAYS_RETURN_OK_TO_META: 'true' } });
    expect((await t.post(webhookPayload(), { secret: false })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('a signed body that cannot be read', () => {
  it.each([
    ['text that is not JSON', 'this is not json'],
    ['an empty body', ''],
    ['bytes that are not UTF-8', Buffer.from([0xff, 0xfe])],
    ['a JSON string', '"hello"'],
    ['a JSON number', '5'],
    ['JSON null', 'null'],
    ['an empty list', '[]'],
    ['an empty object', '{}'],
  ])('%s is a 400 INVALID_PAYLOAD, not a crash', async (_name, raw) => {
    const t = await started();
    const response = await t.post(null, { raw });
    expect(response.status).toBe(400);
    expect(response.json.error_code).toBe('INVALID_PAYLOAD');
    expect(response.json.success).toBe(false);
  });

  // Python's json.loads raises UnicodeDecodeError on bytes that are not UTF-8 (checked on the legacy interpreter). A lenient
  // decoder would turn the bad byte into U+FFFD and go on to read, and answer, a message Meta never sent.
  it('refuses JSON that is well formed except for one byte that is not UTF-8', async () => {
    const t = await started();
    const text = JSON.stringify(webhookPayload({ text: { body: '!d before-after' } }));
    const raw = Buffer.concat([
      Buffer.from(text.slice(0, text.indexOf('before-') + 'before-'.length)),
      Buffer.from([0xff]),
      Buffer.from(text.slice(text.indexOf('before-') + 'before-'.length)),
    ]);
    expect(JSON.parse(raw.toString('utf8'))).toBeTruthy(); // a lenient reader would accept it

    const response = await t.post(null, { raw });
    await t.settle();

    expect(response.status).toBe(400);
    expect(response.json.error_code).toBe('INVALID_PAYLOAD');
    expect(t.replies()).toEqual([]);
  });

  it('does not echo the body in the answer, the log or the report: a JSON syntax error quotes it', async () => {
    const t = await started();
    const response = await t.post(null, { raw: '{"text": a-very-distinctive-question' });
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('a-very-distinctive-question');
    expect(t.log.text()).not.toContain('a-very-distinctive-question');
    expect(JSON.stringify(t.reports.map((r) => r.report))).not.toContain('a-very-distinctive-question');
    expect(t.reports.map((r) => r.report.errorType)).toEqual(['webhook_processing_failure']);
  });

  it('reports an invalid payload, with the request id', async () => {
    const t = await started();
    const response = await t.post({ object: 'whatsapp_business_account', entry: [] });
    expect(response.status).toBe(400);
    expect(t.reports.map((r) => r.report.errorType)).toEqual(['webhook_processing_failure']);
    expect(t.reports[0]!.report.context).toEqual({ request_id: response.headers.get('x-request-id') });
  });

  it('keeps the payload with its text masked in the answer', async () => {
    const t = await started();
    const body = webhookPayload({ from_user_id: 42, text: { body: '!d a-very-distinctive-question' } });
    const response = await t.post(body);
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('a-very-distinctive-question');
  });
});

describe('a message with no one to answer', () => {
  it('without `from_user_id` is an unexpected format, reported, and nobody can be told', async () => {
    const t = await started();
    const body = webhookPayload();
    delete messageOf(body).from_user_id;
    const response = await t.post(body);
    await t.settle();
    expect(response.status).toBe(400);
    expect(response.json.error_code).toBe('UNEXPECTED_PAYLOAD_FORMAT');
    expect(t.reports.map((r) => r.report.errorType)).toEqual(['unexpected_meta_payload']);
    expect(t.replies()).toEqual([]);
    expect(t.log.text()).toContain('No phone number or BSUID in the payload');
  });

  // Python worked out whom to tell from `from_user_id` or the contact's `user_id`, never from the phone
  it('with only a phone, even with META_REPLY_BY_PHONE on: nobody is told, and no phone number is logged', async () => {
    const t = await started({ env: { META_REPLY_BY_PHONE: 'true' } });
    const body = webhookPayload({ from: PHONE });
    delete messageOf(body).from_user_id;
    const response = await t.post(body);
    await t.settle();
    expect(response.json.error_code).toBe('UNEXPECTED_PAYLOAD_FORMAT');
    expect(t.replies()).toEqual([]);
    expect(t.log.text()).not.toContain(PHONE);
  });

  // One number feeds three environments, so only production tells the user (Python PR #390)
  it('missing a key but with the sender in the contacts list: production tells the user the format was unexpected', async () => {
    const t = await started({
      env: { ENVIRONMENT: 'production', MOCK_ANSARI_CLIENT: 'false', MOCK_AUTH_CLIENT: 'false', MOCK_META_API: 'false' },
    });
    const body = webhookPayload({}, { contacts: [{ profile: { name: 'Test User' }, user_id: BSUID }] });
    delete messageOf(body).from_user_id;
    const response = await t.post(body);
    await t.settle();
    expect(response.json.error_code).toBe('UNEXPECTED_PAYLOAD_FORMAT');
    expect(t.recipients()).toEqual([BSUID]);
    expect(t.replies().join('')).toContain('unexpected format');
  });

  it.each(['development', 'staging'])(
    'missing a key in %s, with the sender in the contacts list: reported, but the user is not told',
    async (environment) => {
      const t = await started({ env: { ENVIRONMENT: environment } });
      const body = webhookPayload({}, { contacts: [{ profile: { name: 'Test User' }, user_id: BSUID }] });
      delete messageOf(body).from_user_id;
      const response = await t.post(body);
      await t.settle();
      expect(response.json.error_code).toBe('UNEXPECTED_PAYLOAD_FORMAT');
      expect(t.reports.map((r) => r.report.errorType)).toEqual(['unexpected_meta_payload']);
      expect(t.recipients()).toEqual([]);
      expect(t.replies()).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
describe('a fault in the background work', () => {
  it('is logged and reported, never an unhandled rejection, and the server keeps working', async () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const sent: string[] = [];
      const metaApi: MetaApiService = {
        sendTypingIndicator: async () => {},
        sendInteractiveList: async () => {},
        sendMessage: async (_recipient, parts) => {
          sent.push(...parts);
        },
      };
      const broken: AnsariClient = {
        getPreferences: async () => {
          throw new RangeError('a bug inside the preferences code');
        },
        setPreference: async () => {},
        completeChat: async () => [],
      };
      const t = await started({ metaApi, ansariClient: broken });

      const response = await t.post(webhookPayload());
      await t.settle();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(response.status).toBe(200);
      expect(rejections).toEqual([]);
      // The manager catches it and tells the user; Meta's own refusal is not what is tested here
      expect(sent.join('')).toContain('unexpected error');
      expect((await fetch(`${t.url}/`)).status).toBe(200);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('a task that throws is reported under background_processing_failure with the request id', async () => {
    const t = await started();
    t.background.run(async () => {
      throw new MetaApiError('this escaped everything', 500);
    });
    await t.settle();
    expect(t.reports.map((r) => r.report.errorType)).toEqual(['background_processing_failure']);
    expect(t.reports[0]!.error).toBeInstanceOf(MetaApiError);
    expect(t.log.lines().some((line) => line.level === 'error' && line.message.includes('Unhandled error in background'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('CORS', () => {
  it('lets an allowed origin read the answer', async () => {
    const t = await started();
    const response = await fetch(`${t.url}/`, { headers: { Origin: 'https://allowed.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
  });

  it('gives a disallowed origin no CORS headers, and logs it', async () => {
    const t = await started();
    const response = await fetch(`${t.url}/`, { headers: { Origin: 'https://evil.example' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(t.log.lines().some((line) => line.level === 'error' && line.message.includes('CORS Origin Error'))).toBe(true);
  });

  it('adds no CORS headers to a call with no Origin, which is how Meta\'s servers call', async () => {
    const t = await started();
    const response = await fetch(`${t.url}/`);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(t.log.text()).not.toContain('CORS Origin Error');
  });

  it('always allows the backend URL and WhatsApp Web, which the configuration adds', async () => {
    const t = await started();
    for (const origin of ['http://localhost:3000', 'https://web.whatsapp.com']) {
      const response = await fetch(`${t.url}/`, { headers: { Origin: origin } });
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('answers a preflight from an allowed origin', async () => {
    const t = await started();
    const response = await fetch(`${t.url}${WEBHOOK_PATH}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('everything else', () => {
  it('serves the new path only: the old /whatsapp/v2 is not found', async () => {
    const t = await started();
    expect((await fetch(`${t.url}/whatsapp/v2`)).status).toBe(404);
    expect((await fetch(`${t.url}/whatsapp/v2`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('answers an unknown path with 404 JSON', async () => {
    const t = await started();
    const response = await fetch(`${t.url}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'Not Found' });
  });

  it.each(['development', 'staging'])('serves /sentry-debug in %s, and it fails on purpose', async (environment) => {
    const t = await started({ env: { ENVIRONMENT: environment, MOCK_ANSARI_CLIENT: undefined } });
    const response = await fetch(`${t.url}/sentry-debug`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ detail: 'Internal server error' });
    expect(t.reports.map((r) => r.report.errorType)).toEqual(['unhandled_exception']);
  });

  it('does not serve /sentry-debug in production', async () => {
    const t = await started({
      env: {
        ENVIRONMENT: 'production',
        MOCK_ANSARI_CLIENT: 'false',
        MOCK_AUTH_CLIENT: 'false',
        MOCK_META_API: 'false',
      },
    });
    expect((await fetch(`${t.url}/sentry-debug`)).status).toBe(404);
    expect(t.reports).toEqual([]);
  });

  it('never shows the text of an unexpected error to the caller', async () => {
    const t = await started();
    const response = await fetch(`${t.url}/sentry-debug`);
    expect(await response.text()).not.toContain('Deliberate');
  });
});

describe('the settings the app reads', () => {
  it('uses the payload timestamp the tests froze, so the age check is not time-dependent here', () => {
    expect(FIXED_NOW_UNIX).toBeGreaterThan(0);
  });
});
