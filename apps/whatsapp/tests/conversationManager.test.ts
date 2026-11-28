/**
 * The conversation manager.
 *
 * Python tests ported:
 * - `test_auth_statuses.py` (last half): what the user is told for each sign-in refusal, what the operator is told, one
 *   re-exchange after an apps/api 401 and never a third.
 * - `test_environment_behaviour.py`: maintenance mode, the staging `!d ` filter, an unsupported type in staging.
 * - `test_bsuid_auth_flow.py`: who a reply is addressed to, and that the phone never reaches apps/auth or apps/api.
 * - `test_whatsapp_service.py`: a message with no timestamp or an old one.
 *
 * Phase 3 (spec 360) removed the thread lifecycle from this service: apps/api owns the thread now. The tests for `/expiry`
 * and the chat expiry sit at the end of this file.
 *
 * The Python tests built a manager and reached into its private methods; here the manager is driven through its two public
 * steps (`triage` and `dispatch`), which is also what the HTTP layer will do.
 *
 * Expected notice texts come from `tests/fixtures/pythonOracle.ts`, which ran the Python manager.
 */
import { describe, expect, it } from 'vitest';
import {
  BANNED_NOTICE,
  chatRetentionHours,
  ConversationManager,
  expiryRowId,
  MAINTENANCE_NOTICE,
  parseExpiryChoice,
  rateLimitedNotice,
  SIGN_IN_FAILED_NOTICE,
  unsupportedTypeNotice,
  type IncomingMessage,
  type ManagerConfig,
} from '../src/conversationManager';
import type { ErrorReport } from '../src/errorReporter';
import {
  ApiUnauthorizedError,
  AuthBadRequestError,
  AuthKeyRejectedError,
  AuthRateLimitedError,
  AuthTokenError,
  AuthUserBannedError,
  MessageProcessingError,
  MetaApiError,
  PreferencesError,
} from '../src/errors';
import { runWithRequestId } from '../src/logger';
import { AnsariClientMock, CHAT_RETENTION_PREFERENCE, type AnsariClient } from '../src/services/ansariClient';
import { AuthClientMock, type AuthClient } from '../src/services/authClient';
import { MetaApiServiceMock, type MetaApiService } from '../src/services/metaApiService';
import { FIXED_NOW_UNIX, RATE_LIMITED_NOTICE_CASES, UNSUPPORTED_NOTICE_CASES } from './fixtures/pythonOracle';
import { capturingLogger } from './helpers/network';

const BSUID = 'US.13491208655302741918';
const PHONE = '201234567899';
const NOW = new Date(FIXED_NOW_UNIX * 1000);

const baseConfig: ManagerConfig = {
  WA_MAINTENANCE_MODE: false,
  // Production answers a plain message, which is what the tests of everything else send
  ENVIRONMENT: 'production',
  WHATSAPP_CHAT_RETENTION_HOURS: 3,
  WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS: 86400,
};

function textMessage(overrides: Partial<IncomingMessage> = {}, text = 'hello'): IncomingMessage {
  return {
    kind: 'message',
    bsuid: BSUID,
    messageType: 'text',
    messageBody: { body: text },
    messageId: 'wamid.TEST',
    messageUnixTime: FIXED_NOW_UNIX,
    senderPhone: null,
    ...overrides,
  };
}

/** A list reply, as the webhook parser hands it over: Meta's `interactive` body with a `list_reply`. */
function listReply(id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    kind: 'message',
    bsuid: BSUID,
    messageType: 'interactive',
    messageBody: { type: 'list_reply', list_reply: { id, title: 'picked' } },
    messageId: 'wamid.LIST',
    messageUnixTime: FIXED_NOW_UNIX,
    senderPhone: null,
    ...overrides,
  };
}

/** A manager wired to the in-memory mocks, with every error report and every sent message recorded. */
function setup(
  options: {
    config?: Partial<ManagerConfig>;
    ansariClient?: AnsariClient;
    authClient?: AuthClient;
    metaApi?: MetaApiService;
    clock?: { now: Date };
    typingIntervalMs?: number;
    typingMaxMs?: number;
  } = {},
) {
  const log = capturingLogger();
  const clock = options.clock ?? { now: NOW };
  const ansariClient = options.ansariClient ?? new AnsariClientMock({ logger: log.logger });
  const authClient = options.authClient ?? new AuthClientMock();
  const metaApi = options.metaApi ?? new MetaApiServiceMock({ logger: log.logger, delayMs: 0 });
  const reports: Array<{ error: unknown; report: ErrorReport }> = [];
  const manager = new ConversationManager({
    config: { ...baseConfig, ...options.config },
    ansariClient,
    authClient,
    metaApi,
    logger: log.logger,
    reportError: (error, report) => reports.push({ error, report }),
    now: () => clock.now,
    ...(options.typingIntervalMs === undefined ? {} : { typingIntervalMs: options.typingIntervalMs }),
    ...(options.typingMaxMs === undefined ? {} : { typingMaxMs: options.typingMaxMs }),
  });
  const mock = metaApi as MetaApiServiceMock;
  return {
    manager,
    ansariClient,
    authClient,
    metaApi,
    log,
    clock,
    reports,
    /** Every message part sent, in order, flattened. */
    replies: () => mock.sent.flatMap((call) => call.messageParts),
    /** Who each send was addressed to. */
    recipients: () => mock.sent.map((call) => call.recipient),
    reportedAs: () => reports.map((entry) => entry.report.errorType),
    /** Triage and then carry out whatever it decided, as the HTTP layer will. */
    async handle(message: IncomingMessage) {
      const action = manager.triage(message);
      await manager.dispatch(message, action);
      return action;
    },
  };
}

/** Wraps an apps/api client so a test can make one call fail, count calls, or watch which token was used. */
function wrappedAnsari(inner: AnsariClient, overrides: Partial<AnsariClient>): AnsariClient {
  return {
    completeChat: (...args) => inner.completeChat(...args),
    getPreferences: (...args) => inner.getPreferences(...args),
    setPreference: (...args) => inner.setPreference(...args),
    ...overrides,
  };
}

/** The mock auth client, with the token exchange replaced. */
function authAnswering(getToken: (bsuid: string) => Promise<string>, forget: (bsuid: string) => void = () => {}): AuthClient {
  return { getToken, forget };
}

describe('triage: what happens to a message', () => {
  it('answers a text message', () => {
    expect(setup().manager.triage(textMessage())).toBe('text');
  });

  it.each(['image', 'audio', 'errors', 'unsupported'])('says an %s message is unsupported', (messageType) => {
    expect(setup().manager.triage(textMessage({ messageType }))).toBe('unsupported');
  });

  it('puts maintenance mode before age and type', () => {
    const { manager } = setup({ config: { WA_MAINTENANCE_MODE: true, ENVIRONMENT: 'production' } });
    // An old image: maintenance still wins
    expect(manager.triage(textMessage({ messageType: 'image', messageUnixTime: 1 }))).toBe('maintenance');
  });

  describe('prefix routing (issue #363): which environment answers', () => {
    const NON_TEXT = { messageType: 'image', messageBody: { id: 'media1' } } as const;
    // [environment, message text or 'non-text', expected]; answers are 'text' (or 'unsupported'), ignored ones 'dev_filter'
    const TABLE: Array<[ManagerConfig['ENVIRONMENT'], string, string]> = [
      ['production', 'what is ansari?', 'text'],
      ['production', '!d what is ansari?', 'dev_filter'],
      ['production', '!s what is ansari?', 'dev_filter'],
      ['production', 'non-text', 'unsupported'],
      ['staging', 'what is ansari?', 'dev_filter'],
      ['staging', '!d what is ansari?', 'dev_filter'],
      ['staging', '!s what is ansari?', 'text'],
      ['staging', 'non-text', 'dev_filter'],
      ['development', 'what is ansari?', 'dev_filter'],
      ['development', '!d what is ansari?', 'text'],
      ['development', '!s what is ansari?', 'dev_filter'],
      ['development', 'non-text', 'dev_filter'],
    ];

    it.each(TABLE)('%s, message "%s": %s', (environment, text, expected) => {
      const message = text === 'non-text' ? textMessage(NON_TEXT) : textMessage({}, text);
      expect(setup({ config: { ENVIRONMENT: environment } }).manager.triage(message)).toBe(expected);
    });

    it.each(['!d', '!s', '!dx hello', '!sx hello', ' !s hello', '!S hello', '!D hello'])(
      'does not treat "%s" as a prefix: production answers it, staging and development ignore it',
      (text) => {
        expect(setup({ config: { ENVIRONMENT: 'production' } }).manager.triage(textMessage({}, text))).toBe('text');
        expect(setup({ config: { ENVIRONMENT: 'staging' } }).manager.triage(textMessage({}, text))).toBe('dev_filter');
        expect(setup({ config: { ENVIRONMENT: 'development' } }).manager.triage(textMessage({}, text))).toBe('dev_filter');
      },
    );

    // A bare prefix (nothing but spaces after it) is not a question, and apps/api refuses an empty message, so it is ignored
    it.each([
      ['staging', '!s '],
      ['staging', '!s    '],
      ['development', '!d '],
    ] as const)('%s ignores a bare prefix "%s"', (environment, text) => {
      expect(setup({ config: { ENVIRONMENT: environment } }).manager.triage(textMessage({}, text))).toBe('dev_filter');
    });

    // An ignored message is logged at info, with the environment's name, and never with its text or phone number
    it.each([
      ['staging', '!d hi'],
      ['development', '!s hi'],
    ] as const)('logs an ignored %s message at info, without its text or phone', (environment, text) => {
      const t = setup({ config: { ENVIRONMENT: environment } });
      t.manager.triage(textMessage({ senderPhone: PHONE }, text));
      expect(t.log.lines()).toContainEqual(
        expect.objectContaining({
          level: expect.stringMatching(/^info$/i),
          message: `Ignoring a message meant for another environment (ENVIRONMENT=${environment})`,
        }),
      );
      expect(t.log.text()).not.toContain(PHONE);
      expect(t.log.text()).not.toContain(text);
    });

    // An image caption arrives as `{ body: ... }` too, but only a message of type text carries a prefix
    it('a non-text message has no prefix even when its body looks like one', () => {
      const image = textMessage({ messageType: 'image', messageBody: { body: '!d caption' } });
      expect(setup({ config: { ENVIRONMENT: 'development' } }).manager.triage(image)).toBe('dev_filter');
      expect(setup({ config: { ENVIRONMENT: 'production' } }).manager.triage(image)).toBe('unsupported');
    });

    it('ignores before the maintenance check, so an ignoring environment never sends its maintenance notice', async () => {
      const t = setup({ config: { WA_MAINTENANCE_MODE: true, ENVIRONMENT: 'staging' } });
      expect(await t.handle(textMessage({}, '!d hi'))).toBe('dev_filter');
      expect(await t.handle(textMessage({}, 'hi'))).toBe('dev_filter');
      expect(t.replies()).toEqual([]);
      // The environment that does answer still sends its notice
      expect(await t.handle(textMessage({}, '!s hi'))).toBe('maintenance');
      expect(t.replies()).toEqual([MAINTENANCE_NOTICE]);
    });

    it('ignores a message before the age check, so an old message for another environment is a filter hit', () => {
      const { manager } = setup({ config: { ENVIRONMENT: 'staging' } });
      expect(manager.triage(textMessage({ messageUnixTime: 1 }, '!d old'))).toBe('dev_filter');
    });

    it.each([
      ['staging', '!s what is ansari?'],
      ['development', '!d what is ansari?'],
    ] as const)('%s strips the prefix before the text goes to apps/api', async (environment, text) => {
      const sent: string[] = [];
      const inner = new AnsariClientMock({ logger: capturingLogger().logger });
      const t = setup({
        config: { ENVIRONMENT: environment },
        ansariClient: wrappedAnsari(inner, {
          completeChat: (token, request) => {
            sent.push(request.message);
            return inner.completeChat(token, request);
          },
        }),
      });
      await t.handle(textMessage({}, text));
      expect(sent).toEqual(['what is ansari?']);
    });

    it('production sends a message without a prefix to apps/api unchanged', async () => {
      const sent: string[] = [];
      const inner = new AnsariClientMock({ logger: capturingLogger().logger });
      const t = setup({
        config: { ENVIRONMENT: 'production' },
        ansariClient: wrappedAnsari(inner, {
          completeChat: (token, request) => {
            sent.push(request.message);
            return inner.completeChat(token, request);
          },
        }),
      });
      await t.handle(textMessage({}, 'what is ansari?'));
      expect(sent).toEqual(['what is ansari?']);
    });

    it('an ignored message is not signed in, answered, logged or reported: no phone, BSUID or text', async () => {
      let exchanges = 0;
      const t = setup({
        config: { ENVIRONMENT: 'staging' },
        authClient: authAnswering(async () => {
          exchanges += 1;
          return 'x';
        }),
      });
      const secret = 'my-secret-question-text';
      await t.handle(textMessage({ senderPhone: PHONE }, `!d ${secret}`));
      expect(exchanges).toBe(0);
      expect(t.replies()).toEqual([]);
      expect(t.reports).toEqual([]);
      const logged = t.log.text();
      expect(logged).toContain('another environment'); // the one generic line is there, so the next checks are not vacuous
      for (const private_ of [secret, BSUID, PHONE]) expect(logged).not.toContain(private_);
    });

    // Meta sends an unsupported type (video note, poll...) as an `errors` list, not an object with a body
    it('does not crash on an unsupported type, whose body is a list', () => {
      const message = textMessage({ messageType: 'errors', messageBody: [{ code: 131051, title: 'Message type is not supported' }] });
      expect(setup({ config: { ENVIRONMENT: 'production' } }).manager.triage(message)).toBe('unsupported');
      expect(setup({ config: { ENVIRONMENT: 'staging' } }).manager.triage(message)).toBe('dev_filter');
    });

    it('does not crash on a body that is null or a string', () => {
      const { manager } = setup({ config: { ENVIRONMENT: 'production' } });
      expect(manager.triage(textMessage({ messageType: 'image', messageBody: null }))).toBe('unsupported');
      expect(manager.triage(textMessage({ messageType: 'image', messageBody: 'x' }))).toBe('unsupported');
    });
  });

  describe('message age', () => {
    it('ignores a message older than the threshold', () => {
      expect(setup().manager.triage(textMessage({ messageUnixTime: FIXED_NOW_UNIX - 86401 }))).toBe('too_old');
    });

    it('answers a message exactly at the threshold, and one a second newer', () => {
      const { manager } = setup();
      expect(manager.triage(textMessage({ messageUnixTime: FIXED_NOW_UNIX - 86400 }))).toBe('text');
      expect(manager.triage(textMessage({ messageUnixTime: FIXED_NOW_UNIX - 86399 }))).toBe('text');
    });

    it('answers a message with no timestamp rather than ignoring it', () => {
      expect(setup().manager.triage(textMessage({ messageUnixTime: null }))).toBe('text');
    });

    it('reads the threshold from the settings', () => {
      const { manager } = setup({ config: { WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS: 60 } });
      expect(manager.triage(textMessage({ messageUnixTime: FIXED_NOW_UNIX - 61 }))).toBe('too_old');
      expect(manager.triage(textMessage({ messageUnixTime: FIXED_NOW_UNIX - 59 }))).toBe('text');
    });

    it('checks age before type, so an old image is ignored, not answered', () => {
      expect(setup().manager.triage(textMessage({ messageType: 'image', messageUnixTime: 1 }))).toBe('too_old');
    });

  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('dispatch: the non-text actions', () => {
  it('tells the user the service is down for maintenance, and signs nobody in', async () => {
    let exchanges = 0;
    const t = setup({
      config: { WA_MAINTENANCE_MODE: true },
      authClient: authAnswering(async () => {
        exchanges += 1;
        return 'x';
      }),
    });

    expect(await t.handle(textMessage())).toBe('maintenance');

    expect(t.replies()).toEqual([MAINTENANCE_NOTICE]);
    expect(exchanges).toBe(0);
  });

  it('sends nothing for a dev-filtered or too-old message', async () => {
    const t = setup({ config: { ENVIRONMENT: 'staging' } });
    await t.handle(textMessage({}, '!d hi'));
    await t.handle(textMessage({ messageUnixTime: 1 }));
    expect(t.replies()).toEqual([]);
  });

  it.each(UNSUPPORTED_NOTICE_CASES.filter(([type]) => type !== ''))('tells the user about a "%s" message as Python did', async (type, python) => {
    const t = setup();
    await t.manager.dispatch(textMessage({ messageType: type }), 'unsupported');
    expect(t.replies()).toEqual(python);
  });

  it('sends nothing for a message with an empty type, as Python did', async () => {
    const t = setup();
    await t.manager.dispatch(textMessage({ messageType: '' }), 'unsupported');
    expect(t.replies()).toEqual([]);
    expect(UNSUPPORTED_NOTICE_CASES.find(([type]) => type === '')![1]).toEqual([]);
  });

  it('needs no sign-in to refuse an unsupported type', async () => {
    let exchanges = 0;
    const t = setup({
      authClient: authAnswering(async () => {
        exchanges += 1;
        return 'x';
      }),
    });
    await t.handle(textMessage({ messageType: 'image' }));
    expect(exchanges).toBe(0);
    expect(t.replies()).toHaveLength(1);
  });

  it('exposes the notice builders the oracle checked', () => {
    expect(unsupportedTypeNotice('unsupported')).toBe("Sorry, I can't process this media type yet. Please send me a text message.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('who a reply goes to, and what identifies the user', () => {
  it('replies to the BSUID by default, and signs in with it', async () => {
    const exchanged: string[] = [];
    const mock = new AuthClientMock();
    const t = setup({
      authClient: authAnswering(async (bsuid) => {
        exchanged.push(bsuid);
        return mock.getToken(bsuid);
      }),
    });

    await t.handle(textMessage({ senderPhone: null }));

    expect(exchanged).toEqual([BSUID]);
    expect(new Set(t.recipients())).toEqual(new Set([BSUID]));
  });

  it('replies to the phone when the parser supplied one, but still signs in with the BSUID', async () => {
    const exchanged: string[] = [];
    const mock = new AuthClientMock();
    const t = setup({
      authClient: authAnswering(async (bsuid) => {
        exchanged.push(bsuid);
        return mock.getToken(bsuid);
      }),
    });

    await t.handle(textMessage({ senderPhone: PHONE }));

    expect(exchanged).toEqual([BSUID]);
    expect(new Set(t.recipients())).toEqual(new Set([PHONE]));
  });

  it('sends the typing indicator to the BSUID even when replies go to the phone', async () => {
    const typing: string[] = [];
    const metaApi: MetaApiService = {
      sendTypingIndicator: async (recipient) => {
        typing.push(recipient);
      },
      sendInteractiveList: async () => {},
      sendMessage: async () => {},
    };
    const t = setup({ metaApi });

    await t.handle(textMessage({ senderPhone: PHONE }));

    expect(typing).toEqual([BSUID]);
  });

  it('never puts the phone number in any call to apps/auth or apps/api, or in a log line', async () => {
    const seen: string[] = [];
    const log = capturingLogger();
    const mockAuth = new AuthClientMock();
    const inner = new AnsariClientMock({ logger: log.logger });
    const record = (...args: unknown[]) => seen.push(JSON.stringify(args));
    const t = setup({
      authClient: authAnswering(async (bsuid) => {
        record('auth', bsuid);
        return mockAuth.getToken(bsuid);
      }),
      ansariClient: wrappedAnsari(inner, {
        getPreferences: async (...args) => (record('prefs', ...args), inner.getPreferences(...args)),
        completeChat: async (...args) => (record('chat', ...args), inner.completeChat(...args)),

      }),
    });

    await t.handle(textMessage({ senderPhone: PHONE }, 'a-very-distinctive-question'));

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.some((line) => line.includes(PHONE))).toBe(false);
    expect(t.log.text()).not.toContain(PHONE);
  });

  it('writes no BSUID, phone number or message text to the logs', async () => {
    const t = setup();
    await t.handle(textMessage({ senderPhone: PHONE }, 'a-very-distinctive-question'));
    const text = t.log.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(BSUID);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('a-very-distinctive-question');
  });

  it('does not answer a message with no recipient at all, and says so in the log', async () => {
    const t = setup();
    await t.manager.notify('', 'hello');
    expect(t.replies()).toEqual([]);
    expect(t.log.text()).toContain('No recipient');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('sign-in: what the user and the operator are told', () => {
  function failingExchange(error: unknown) {
    return setup({
      authClient: authAnswering(async () => {
        throw error;
      }),
    });
  }

  it.each([
    [new AuthKeyRejectedError('401'), 'auth_key_rejected'],
    [new AuthBadRequestError('400'), 'auth_bad_request'],
    [new AuthTokenError('500'), 'auth_token_failure'],
    [new TypeError('something else entirely'), 'auth_token_failure'],
  ])('reports %s to the operator as "%s"', async (error, reportedAs) => {
    const t = failingExchange(error);
    await t.handle(textMessage());
    expect(t.reportedAs()).toEqual([reportedAs]);
    expect(t.reports[0]!.error).toBe(error);
  });

  it.each([new AuthUserBannedError('403'), new AuthRateLimitedError('429', 300)])('does not report %s as an operator alert', async (error) => {
    const t = failingExchange(error);
    await t.handle(textMessage());
    expect(t.reports).toEqual([]);
  });

  it('tells the user the right thing for each refusal, and a different thing for three of the four', async () => {
    const notices: Record<string, string> = {};
    for (const [name, error] of Object.entries({
      banned: new AuthUserBannedError('403'),
      limited: new AuthRateLimitedError('429', 300),
      key: new AuthKeyRejectedError('401'),
      outage: new AuthTokenError('500'),
    })) {
      const t = failingExchange(error);
      await t.handle(textMessage());
      notices[name] = t.replies().join('');
    }

    expect(notices.banned).toBe(BANNED_NOTICE);
    expect(notices.limited).toContain('5 minutes');
    expect(notices.key).toBe(SIGN_IN_FAILED_NOTICE);
    expect(notices.outage).toBe(SIGN_IN_FAILED_NOTICE);
    expect(new Set(Object.values(notices)).size).toBe(3);
  });

  it('does not start the typing indicator, or ask apps/api anything, when sign-in fails', async () => {
    let typing = 0;
    let apiCalls = 0;
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger });
    const t = setup({
      authClient: authAnswering(async () => {
        throw new AuthTokenError('500');
      }),
      ansariClient: wrappedAnsari(inner, {
        getPreferences: async (...args) => (apiCalls++, inner.getPreferences(...args)),
      }),
      metaApi: {
        sendTypingIndicator: async () => {
          typing += 1;
        },
        sendInteractiveList: async () => {},
        sendMessage: async () => {},
      },
    });

    await t.handle(textMessage());

    expect(typing).toBe(0);
    expect(apiCalls).toBe(0);
  });

  it('a stale notice is not reused: each message gets the notice for its own failure', async () => {
    let failure: Error = new AuthUserBannedError('403');
    const t = setup({
      authClient: authAnswering(async () => {
        throw failure;
      }),
    });
    await t.handle(textMessage());
    failure = new AuthTokenError('500');
    await t.handle(textMessage());
    expect(t.replies()).toEqual([BANNED_NOTICE, SIGN_IN_FAILED_NOTICE]);
  });

  it('an empty BSUID cannot sign in and nothing is sent to an empty recipient', async () => {
    const t = setup();
    await t.manager.dispatch(textMessage({ bsuid: '' }), 'text');
    expect(t.replies()).toEqual([]);
    expect(t.log.text()).toContain('bsuid is not set');
  });

  describe('the rate-limit notice', () => {
    it.each(RATE_LIMITED_NOTICE_CASES)('a wait of %s seconds reads as Python did', (seconds, python) => {
      expect(rateLimitedNotice(seconds)).toBe(python);
    });
  });

  it('keeps the reports free of the BSUID, the token and the message text', async () => {
    const t = failingExchange(new AuthTokenError('apps/auth is down'));
    await runWithRequestId('req-123', () => t.handle(textMessage({}, 'a-very-distinctive-question')));
    const report = JSON.stringify(t.reports[0]!.report);
    expect(report).toContain('req-123');
    expect(report).not.toContain(BSUID);
    expect(report).not.toContain('a-very-distinctive-question');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('sending', () => {
  it('tells the user when Meta refuses the answer', async () => {
    const sent: string[][] = [];
    let attempts = 0;
    const metaApi: MetaApiService = {
      sendTypingIndicator: async () => {},
      sendInteractiveList: async () => {},
      sendMessage: async (_recipient, parts) => {
        attempts += 1;
        if (attempts === 1) throw new MetaApiError('Meta said no', 400);
        sent.push(parts);
      },
    };
    const t = setup({ metaApi });
    await expect(t.handle(textMessage())).resolves.toBe('text');
    expect(t.log.lines().some((line) => line.level === 'error' && line.message.includes('Error sending WhatsApp message'))).toBe(true);
    expect(attempts).toBe(2);
    expect(sent[0]?.[0]).toContain('An error occurred while processing your message');
  });

  it('survives Meta refusing a notice', async () => {
    const metaApi: MetaApiService = {
      sendTypingIndicator: async () => {},
      sendInteractiveList: async () => {},
      sendMessage: async () => {
        throw new MetaApiError('Meta said no', 400);
      },
    };
    const t = setup({ metaApi, config: { WA_MAINTENANCE_MODE: true } });
    await expect(t.handle(textMessage())).resolves.toBe('maintenance');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the typing indicator', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** An apps/api whose chat answer arrives only when the test lets it. */
  function slowAnswer() {
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { release: () => release(), client: wrappedAnsari(inner, { completeChat: async (...args) => (await gate, inner.completeChat(...args)) }) };
  }

  function typingCounter() {
    const state = { typing: 0, ids: [] as string[] };
    const metaApi = new MetaApiServiceMock({ logger: capturingLogger().logger, delayMs: 0 });
    const counting: MetaApiService = {
      sendTypingIndicator: async (recipient, messageId) => {
        state.typing += 1;
        state.ids.push(`${recipient}/${messageId}`);
      },
      sendInteractiveList: (recipient, list) => metaApi.sendInteractiveList(recipient, list),
      sendMessage: (recipient, parts) => metaApi.sendMessage(recipient, parts),
    };
    return { state, counting, mock: metaApi };
  }

  it('sends one indicator at once and more while the answer is slow, then stops when it arrives', async () => {
    const slow = slowAnswer();
    const counter = typingCounter();
    const t = setup({ ansariClient: slow.client, metaApi: counter.counting, typingIntervalMs: 10 });

    const done = t.handle(textMessage());
    await wait(60);
    expect(counter.state.typing).toBeGreaterThan(2);

    slow.release();
    await done;
    const atFinish = counter.state.typing;
    await wait(60);
    expect(counter.state.typing).toBe(atFinish);
  });

  it('shows the indicator for the sender\'s own message id', async () => {
    const counter = typingCounter();
    const t = setup({ metaApi: counter.counting });
    await t.handle(textMessage());
    expect(counter.state.ids[0]).toBe(`${BSUID}/wamid.TEST`);
  });

  it('stops after the maximum duration even if the answer never comes', async () => {
    const slow = slowAnswer();
    const counter = typingCounter();
    const clock = { now: NOW };
    const t = setup({ ansariClient: slow.client, metaApi: counter.counting, typingIntervalMs: 10, typingMaxMs: 25, clock });

    const done = t.handle(textMessage());
    // Move the clock past the limit as real time passes
    const ticker = setInterval(() => (clock.now = new Date(clock.now.getTime() + 10)), 5);
    await wait(120);
    clearInterval(ticker);
    const atLimit = counter.state.typing;
    await wait(60);
    expect(counter.state.typing).toBe(atLimit);
    expect(t.log.text()).toContain('exceeded maximum duration');

    slow.release();
    await done;
  });

  it('stops when the answer fails', async () => {
    const counter = typingCounter();
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger });
    const t = setup({
      metaApi: counter.counting,
      typingIntervalMs: 10,
      ansariClient: wrappedAnsari(inner, {
        completeChat: async () => {
          throw new MessageProcessingError('boom');
        },
      }),
    });
    await t.handle(textMessage());
    const atFinish = counter.state.typing;
    await wait(60);
    expect(counter.state.typing).toBe(atFinish);
  });

  it('stops after an unexpected fault', async () => {
    const counter = typingCounter();
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger });
    const t = setup({
      metaApi: counter.counting,
      typingIntervalMs: 10,
      ansariClient: wrappedAnsari(inner, {
        completeChat: async () => {
          throw new RangeError('bug');
        },
      }),
    });
    await t.handle(textMessage());
    const atFinish = counter.state.typing;
    await wait(60);
    expect(counter.state.typing).toBe(atFinish);
  });

  it('keeps going when one indicator fails to send', async () => {
    const slow = slowAnswer();
    let attempts = 0;
    const metaApi: MetaApiService = {
      sendTypingIndicator: async () => {
        attempts += 1;
        throw new MetaApiError('Meta said no', 500);
      },
      sendInteractiveList: async () => {},
      sendMessage: async () => {},
    };
    const t = setup({ ansariClient: slow.client, metaApi, typingIntervalMs: 10 });
    const done = t.handle(textMessage());
    await wait(60);
    expect(attempts).toBeGreaterThan(2);
    slow.release();
    await done;
  });

  it('is not started when the message has no id to attach it to', async () => {
    const counter = typingCounter();
    const t = setup({ metaApi: counter.counting });
    await t.handle(textMessage({ messageId: null }));
    expect(counter.state.typing).toBe(0);
    expect(t.log.text()).toContain('missing bsuid or message_id');
    expect(counter.mock.sent).toHaveLength(1); // the answer is still sent
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const PROCESSING_FAILED = 'An error occurred while processing your message. Please try again later.';
const EMPTY_ANSWER = "Sorry, we couldn't process your message. Please try again later.";

describe('a normal answer', () => {
  it('signs in, asks apps/api with the default expiry, and sends the messages as they come, in order', async () => {
    const seen: Array<{ token: string; request: { message: string; expiryHours: number } }> = [];
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    const t = setup({
      ansariClient: wrappedAnsari(inner, {
        completeChat: async (token, request) => {
          seen.push({ token, request });
          return ['*first* part', 'second part'];
        },
      }),
    });

    expect(await t.handle(textMessage({}, 'What is patience?'))).toBe('text');
    expect(seen).toEqual([{ token: expect.any(String), request: { message: 'What is patience?', expiryHours: 3 } }]);
    expect(t.replies()).toEqual(['*first* part', 'second part']);
    expect(t.recipients()).toEqual([BSUID]);
  });

  it('sends the stored expiry, read from the preferences of the signed-in user', async () => {
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    await inner.setPreference('tok', CHAT_RETENTION_PREFERENCE, '0');
    const seen: number[] = [];
    const t = setup({
      authClient: authAnswering(async () => 'tok'),
      ansariClient: wrappedAnsari(inner, {
        completeChat: async (_token, request) => {
          seen.push(request.expiryHours);
          return ['ok'];
        },
      }),
    });
    await t.handle(textMessage());
    expect(seen).toEqual([0]);
  });

  it('falls back to WHATSAPP_CHAT_RETENTION_HOURS when nothing is stored', async () => {
    const seen: number[] = [];
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    const t = setup({
      config: { WHATSAPP_CHAT_RETENTION_HOURS: 6 },
      ansariClient: wrappedAnsari(inner, {
        completeChat: async (_token, request) => {
          seen.push(request.expiryHours);
          return ['ok'];
        },
      }),
    });
    await t.handle(textMessage());
    expect(seen).toEqual([6]);
  });

  it.each(['30', 'soon', '-1'])('warns and uses the default when the stored expiry is %j', async (stored) => {
    const seen: number[] = [];
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    await inner.setPreference('tok', CHAT_RETENTION_PREFERENCE, stored);
    const t = setup({
      authClient: authAnswering(async () => 'tok'),
      ansariClient: wrappedAnsari(inner, {
        completeChat: async (_token, request) => {
          seen.push(request.expiryHours);
          return ['ok'];
        },
      }),
    });
    await t.handle(textMessage());
    expect(seen).toEqual([3]);
    expect(t.log.text()).toContain('A stored chat expiry is not valid; the default is used');
  });

  it('drops blank parts, since WhatsApp refuses them', async () => {
    const t = setup({
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async () => ['ok', '   ', ''],
      }),
    });
    await t.handle(textMessage());
    expect(t.replies()).toEqual(['ok']);
  });
});

describe('an answer with nothing to send', () => {
  it.each([
    ['an empty list', []],
    ['only blank parts', ['  ', '\n']],
  ])('tells the user when apps/api sends %s', async (_name, messages) => {
    const t = setup({
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async () => messages,
      }),
    });
    await t.handle(textMessage());
    expect(t.replies()).toEqual([EMPTY_ANSWER]);
    expect(t.reports).toEqual([]); // an empty answer is not an operator error
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('one re-exchange after an apps/api 401', () => {
  /** A sign-in that hands out `stale` first and `fresh` afterwards, and records the order of exchanges and forgets. */
  function twoTokens(events: string[]): AuthClient {
    let exchanges = 0;
    return authAnswering(
      async () => {
        exchanges += 1;
        events.push('exchange');
        return exchanges === 1 ? 'stale' : 'fresh';
      },
      () => events.push('forget'),
    );
  }

  it('drops the stale token, exchanges once more, and answers the message with the fresh token', async () => {
    const events: string[] = [];
    const t = setup({
      authClient: twoTokens(events),
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async (token) => {
          if (token === 'stale') throw new ApiUnauthorizedError('refused');
          return [`answer for ${token}`];
        },
      }),
    });
    await t.handle(textMessage());
    expect(t.replies()).toEqual(['answer for fresh']);
  });

  it('forgets the stale token before asking again, not after', async () => {
    const events: string[] = [];
    const t = setup({
      authClient: twoTokens(events),
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async (token) => {
          if (token === 'stale') throw new ApiUnauthorizedError('refused');
          return ['ok'];
        },
      }),
    });
    await t.handle(textMessage());
    expect(events).toEqual(['exchange', 'forget', 'exchange']);
  });

  it('gives up after a second 401: never a third exchange or a third attempt', async () => {
    const events: string[] = [];
    let calls = 0;
    const t = setup({
      authClient: twoTokens(events),
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async () => {
          calls += 1;
          throw new ApiUnauthorizedError('refused');
        },
      }),
    });
    await t.handle(textMessage());
    expect(calls).toBe(2);
    expect(events.filter((event) => event === 'exchange')).toHaveLength(2);
    expect(t.replies()).toEqual([PROCESSING_FAILED]);
    expect(t.reportedAs()).toEqual(['api_unauthorized_after_reexchange']);
  });

  it('tells a user found banned on the re-exchange so, and does not retry', async () => {
    let exchanges = 0;
    let calls = 0;
    const t = setup({
      authClient: authAnswering(async () => {
        exchanges += 1;
        if (exchanges === 2) throw new AuthUserBannedError('banned');
        return 'stale';
      }),
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async () => {
          calls += 1;
          throw new ApiUnauthorizedError('refused');
        },
      }),
    });
    await t.handle(textMessage());
    expect(calls).toBe(1);
    expect(t.replies()).toEqual([BANNED_NOTICE]);
  });

  it('does not tell the user they are sending too quickly when the re-exchange is rate limited', async () => {
    let exchanges = 0;
    const t = setup({
      authClient: authAnswering(async () => {
        exchanges += 1;
        if (exchanges === 2) throw new AuthRateLimitedError('slow down', 60);
        return 'stale';
      }),
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async () => {
          throw new ApiUnauthorizedError('refused');
        },
      }),
    });
    await t.handle(textMessage());
    expect(t.replies()).toEqual([SIGN_IN_FAILED_NOTICE]);
  });

  it('does not retry a failure that is not a 401', async () => {
    const events: string[] = [];
    let calls = 0;
    const t = setup({
      authClient: twoTokens(events),
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        completeChat: async () => {
          calls += 1;
          throw new MessageProcessingError('boom');
        },
      }),
    });
    await t.handle(textMessage());
    expect(calls).toBe(1);
    expect(events).toEqual(['exchange']);
    expect(t.replies()).toEqual([PROCESSING_FAILED]);
    expect(t.reportedAs()).toEqual(['message_processing_failure']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('/expiry: the chat expiry list', () => {
  it('sends a list with the current setting and one row per choice, each id naming this environment', async () => {
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    await inner.setPreference('tok', CHAT_RETENTION_PREFERENCE, '6');
    let answered = false;
    const t = setup({
      authClient: authAnswering(async () => 'tok'),
      ansariClient: wrappedAnsari(inner, {
        completeChat: async () => {
          answered = true;
          return ['never'];
        },
      }),
    });

    expect(await t.handle(textMessage({}, '/expiry'))).toBe('expiry_command');
    const { lists } = t.metaApi as MetaApiServiceMock;
    expect(lists).toHaveLength(1);
    expect(lists[0]?.recipient).toBe(BSUID);
    expect(lists[0]?.list.bodyText).toContain('6 hours');
    expect(lists[0]?.list.rows.map((row) => row.id)).toEqual([0, 1, 2, 3, 6, 12, 24].map((h) => `expiry:${h}:production`));
    for (const row of lists[0]?.list.rows ?? []) expect([...row.title].length).toBeLessThanOrEqual(24);
    expect(answered).toBe(false);
    expect(t.replies()).toEqual([]);
  });

  it('shows the default when nothing is stored yet', async () => {
    const t = setup();
    await t.handle(textMessage({}, '/expiry'));
    expect((t.metaApi as MetaApiServiceMock).lists[0]?.list.bodyText).toContain('3 hours');
  });

  it('is recognised after the staging prefix, in any case and with spaces around it', async () => {
    const t = setup({ config: { ENVIRONMENT: 'staging' } });
    expect(t.manager.triage(textMessage({}, '!s  /Expiry '))).toBe('expiry_command');
  });

  it('is not a command inside a longer message, and needs the staging prefix on staging', () => {
    const t = setup({ config: { ENVIRONMENT: 'staging' } });
    expect(t.manager.triage(textMessage({}, '!s /expiry please'))).toBe('text');
    expect(t.manager.triage(textMessage({}, '/expiry'))).toBe('dev_filter');
  });

  it('uses the configured default when the preference cannot be read', async () => {
    const t = setup({
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        getPreferences: async () => {
          throw new PreferencesError('apps/api is down');
        },
      }),
    });
    await t.handle(textMessage({}, '/expiry'));
    expect((t.metaApi as MetaApiServiceMock).lists).toHaveLength(1);
    expect((t.metaApi as MetaApiServiceMock).lists[0]?.list.bodyText).toContain('3 hours');
    expect(t.replies()).toEqual([]);
    expect(t.reportedAs()).toEqual([]);
    expect(t.log.text()).toContain('using the configured default');
  });
});

describe('a list reply: saving the chat expiry', () => {
  it('saves the chosen hours and confirms them', async () => {
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    const t = setup({
      authClient: authAnswering(async () => 'tok'),
      ansariClient: wrappedAnsari(inner, {}),
    });
    expect(await t.handle(listReply(expiryRowId(6, 'production')))).toBe('list_reply');
    expect((await inner.getPreferences('tok'))[CHAT_RETENTION_PREFERENCE]).toBe('6');
    expect(t.replies()).toEqual(['Done. Your chat setting is now 6 hours.']);
  });

  it('confirms a choice of 0 as a new session for every message', async () => {
    const t = setup();
    await t.handle(listReply(expiryRowId(0, 'production')));
    expect(t.replies()).toEqual(['Done. Your chat setting is now a new session for every message.']);
  });

  it('saves a staging choice on staging, where the row id names staging', async () => {
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    const t = setup({
      config: { ENVIRONMENT: 'staging' },
      authClient: authAnswering(async () => 'tok'),
      ansariClient: wrappedAnsari(inner, {}),
    });
    await t.handle(listReply(expiryRowId(12, 'staging')));
    expect((await inner.getPreferences('tok'))[CHAT_RETENTION_PREFERENCE]).toBe('12');
  });

  it("is not answered by an environment other than the one that sent the list", async () => {
    let saved = false;
    const t = setup({
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        setPreference: async () => {
          saved = true;
        },
      }),
    });
    expect(t.manager.triage(listReply(expiryRowId(3, 'staging')))).toBe('dev_filter');
    expect(saved).toBe(false);
    expect(t.replies()).toEqual([]);
  });

  it('a row this environment did not offer gets a short notice, and nothing is saved', async () => {
    const inner = new AnsariClientMock({ logger: capturingLogger().logger });
    const t = setup({ authClient: authAnswering(async () => 'tok'), ansariClient: wrappedAnsari(inner, {}) });
    await t.handle(listReply('expiry:5:production'));
    expect(t.replies()).toEqual(['Sorry, that option is no longer available. Send /expiry to choose again.']);
    expect(await inner.getPreferences('tok')).toEqual({});
  });

  it('a failed save tells the user and is reported', async () => {
    const t = setup({
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        setPreference: async () => {
          throw new PreferencesError('apps/api is down');
        },
      }),
    });
    await t.handle(listReply(expiryRowId(1, 'production')));
    expect(t.replies()).toEqual(['An error occurred while saving your chat setting. Please try again later.']);
    expect(t.reportedAs()).toEqual(['preferences_failure']);
  });

  it('signs the user in first: a refused sign-in is told, and nothing is saved', async () => {
    let saved = false;
    const t = setup({
      authClient: authAnswering(async () => {
        throw new AuthUserBannedError('banned');
      }),
      ansariClient: wrappedAnsari(new AnsariClientMock({ logger: capturingLogger().logger }), {
        setPreference: async () => {
          saved = true;
        },
      }),
    });
    await t.handle(listReply(expiryRowId(1, 'production')));
    expect(t.replies()).toEqual([BANNED_NOTICE]);
    expect(saved).toBe(false);
  });

  it('a button reply is still unsupported, not mistaken for a list reply', () => {
    const t = setup();
    const button = textMessage({
      messageType: 'interactive',
      messageBody: { type: 'button_reply', button_reply: { id: 'x', title: 'y' } },
    });
    expect(t.manager.triage(button)).toBe('unsupported');
  });
});

describe('chat expiry helpers', () => {
  it.each([
    [undefined, 3],
    ['0', 0],
    ['24', 24],
    ['25', 3],
    ['-1', 3],
    ['2.5', 3],
    ['', 3],
    ['soon', 3],
  ])('a stored %j becomes %j (the default is 3)', (stored, expected) => {
    expect(chatRetentionHours(stored, 3)).toBe(expected);
  });

  it('reads a list reply id only when this environment offered it', () => {
    expect(parseExpiryChoice('expiry:6:production', 'production')).toBe(6);
    expect(parseExpiryChoice('expiry:24:production', 'production')).toBe(24);
    expect(parseExpiryChoice('expiry:5:production', 'production')).toBeUndefined();
    expect(parseExpiryChoice('expiry:6:staging', 'production')).toBeUndefined();
    expect(parseExpiryChoice('6', 'production')).toBeUndefined();
  });
});
