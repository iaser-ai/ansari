/**
 * Test helper for the HTTP layer: the real app, listening on a free port, with the in-memory clients behind it.
 *
 * Python counterpart: FastAPI's `TestClient(app)`. Express has no built-in test client, so the app really listens (on port 0,
 * which the operating system turns into any free port) and a test calls it with `fetch`, exactly as Meta would over a network.
 * Nothing leaves the machine.
 */
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/app';
import { BackgroundTasks } from '../../src/background';
import { buildConfig, type Env } from '../../src/config';
import { ConversationManager } from '../../src/conversationManager';
import type { ErrorReport } from '../../src/errorReporter';
import type { AnsariClient } from '../../src/services/ansariClient';
import { AnsariClientMock } from '../../src/services/ansariClient';
import { AuthClientMock, type AuthClient } from '../../src/services/authClient';
import { MetaApiServiceMock, type MetaApiService } from '../../src/services/metaApiService';
import { FIXED_NOW_UNIX } from '../fixtures/pythonOracle';
import { capturingLogger } from './network';

/**
 * Ports `fetch` refuses to call (the Fetch standard's "bad ports", at 1024 and above; the rest are below any port the system hands
 * out). Port 0 lets the system choose, and on a machine whose automatic range includes one of these, a test would fail now and then
 * with `bad port` for no reason connected to the code.
 * https://fetch.spec.whatwg.org/#port-blocking
 */
const FETCH_BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** Listen on 127.0.0.1 on a port chosen by the system, asking again whenever it picks one `fetch` will not call. */
export async function listenOnFetchablePort(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<Server> {
  for (;;) {
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const port = (server.address() as AddressInfo).port;
    if (!FETCH_BAD_PORTS.has(port)) return server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export const APP_SECRET = 'test-app-secret';
export const VERIFY_TOKEN = 'test-verify-token';
export const PHONE_NUMBER_ID = '123456789';
export const BSUID = 'US.13491208655302741918';
export const PHONE = '201234567899';
export const NOW = new Date(FIXED_NOW_UNIX * 1000);

/** The smallest valid environment, with the mocks on (as in CI) and `ALWAYS_RETURN_OK_TO_META` off so statuses are real. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return buildConfig({
    DEPLOYMENT_TYPE: 'local',
    AUTH_WHATSAPP_API_KEY: 'test-key',
    META_BUSINESS_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
    META_ACCESS_TOKEN_FROM_SYS_USER: 'test-token',
    META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    META_ANSARI_APP_SECRET: APP_SECRET,
    ALWAYS_RETURN_OK_TO_META: 'false',
    ORIGINS: 'https://allowed.example',
    ...overrides,
  });
}

/** What Meta sends for one text message from `from_user_id` to our number. */
export function webhookPayload(
  message: Record<string, unknown> = {},
  options: { phoneNumberId?: string; contacts?: unknown[] } = {},
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    metadata: { phone_number_id: options.phoneNumberId ?? PHONE_NUMBER_ID, display_phone_number: '+1234567890' },
    messages: [
      {
        from_user_id: BSUID,
        id: 'wamid.TEST',
        timestamp: String(FIXED_NOW_UNIX),
        type: 'text',
        // The tests run as `development`, which answers only messages with the `!d ` prefix (and strips it)
        text: { body: '!d hello' },
        ...message,
      },
    ],
  };
  if (options.contacts) value.contacts = options.contacts;
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value }] }] };
}

/** The message object inside a payload built by `webhookPayload`, so a test can remove or add a key. */
export function messageOf(payload: Record<string, unknown>): Record<string, unknown> {
  const entry = (payload.entry as Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }>)[0]!;
  return entry.changes[0]!.value.messages[0]!;
}

/** `sha256=<hex>`, the value Meta puts in `X-Hub-Signature-256`. */
export function sign(body: string | Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface TestApp {
  url: string;
  env: Env;
  background: BackgroundTasks;
  log: ReturnType<typeof capturingLogger>;
  /** Error reports sent to the operator. */
  reports: Array<{ error: unknown; report: ErrorReport }>;
  /** Every message part sent to a user, flattened, in order. */
  replies: () => string[];
  /** Who each send was addressed to. */
  recipients: () => string[];
  /** Wait for the work started after Meta was answered. Fails the test if it does not finish. */
  settle: () => Promise<void>;
  /** POST a body to the webhook, signed unless told otherwise. */
  post: (body: unknown, options?: PostOptions) => Promise<{ status: number; json: Record<string, unknown>; headers: Headers; text: string }>;
  close: () => Promise<void>;
}

export interface PostOptions {
  /** Sign with this secret. `false` sends no signature at all. */
  secret?: string | false;
  /** Replace the signature header outright. */
  signature?: string;
  /** The body as bytes or text, instead of the JSON of `body`. */
  raw?: string | Buffer;
  contentType?: string | null;
  headers?: Record<string, string>;
}

export async function startApp(
  options: {
    env?: Record<string, string | undefined>;
    ansariClient?: AnsariClient;
    authClient?: AuthClient;
    metaApi?: MetaApiService;
  } = {},
): Promise<TestApp> {
  const env = testEnv(options.env);
  const log = capturingLogger();
  const reports: TestApp['reports'] = [];
  const reportError = (error: unknown, report: ErrorReport) => reports.push({ error, report });

  const metaMock = new MetaApiServiceMock({ logger: log.logger, delayMs: 0 });
  const background = new BackgroundTasks({ logger: log.logger, reportError });
  const manager = new ConversationManager({
    config: env,
    ansariClient: options.ansariClient ?? new AnsariClientMock({ logger: log.logger, now: () => NOW }),
    authClient: options.authClient ?? new AuthClientMock(),
    metaApi: options.metaApi ?? metaMock,
    logger: log.logger,
    reportError,
    now: () => NOW,
  });
  const app = buildApp({ config: env, manager, background, logger: log.logger, reportError });

  const server = await listenOnFetchablePort(app);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    env,
    background,
    log,
    reports,
    replies: () => metaMock.sent.flatMap((call) => call.messageParts),
    recipients: () => metaMock.sent.map((call) => call.recipient),
    async settle() {
      if (!(await background.idle(5_000))) throw new Error('background work did not finish within 5 s');
    },
    async post(body, postOptions = {}) {
      const raw = postOptions.raw ?? JSON.stringify(body);
      const headers: Record<string, string> = { ...postOptions.headers };
      if (postOptions.contentType !== null) headers['Content-Type'] = postOptions.contentType ?? 'application/json';
      if (postOptions.signature !== undefined) headers['X-Hub-Signature-256'] = postOptions.signature;
      else if (postOptions.secret !== false) headers['X-Hub-Signature-256'] = sign(raw, postOptions.secret ?? APP_SECRET);
      const response = await fetch(`${url}/whatsapp/v3`, { method: 'POST', headers, body: raw });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // not JSON: the caller reads `text`
      }
      return { status: response.status, json, headers: response.headers, text };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
