/**
 * The conversation manager.
 *
 * Python tests ported:
 * - `test_thread_lifecycle.py`: one thread per user, three-hour expiry, the `Z` timestamp apps/api sends, a failed delete
 *   never leaves two threads, each thread failure is reported under its own name.
 * - `test_auth_statuses.py` (last half): what the user is told for each sign-in refusal, what the operator is told, one
 *   re-exchange after an apps/api 401 and never a third.
 * - `test_environment_behaviour.py`: maintenance mode, the staging `!d ` filter, an unsupported type in staging.
 * - `test_bsuid_auth_flow.py`: who a reply is addressed to, and that the phone never reaches apps/auth or apps/api.
 * - `test_whatsapp_service.py`: a message with no timestamp or an old one.
 *
 * The Python tests built a manager and reached into its private methods; here the manager is driven through its two public
 * steps (`triage` and `dispatch`), which is also what the HTTP layer will do.
 *
 * Expected notice texts come from `tests/fixtures/pythonOracle.ts`, which ran the Python manager.
 */
import { describe, expect, it } from 'vitest';
import {
  BANNED_NOTICE,
  ConversationManager,
  MAINTENANCE_NOTICE,
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
  ThreadCreationError,
  ThreadDeletionError,
  ThreadInfoError,
} from '../src/errors';
import { runWithRequestId } from '../src/logger';
import { AnsariClientMock, type AnsariClient, type ThreadInfo } from '../src/services/ansariClient';
import { AuthClientMock, type AuthClient } from '../src/services/authClient';
import { MetaApiServiceMock, type MetaApiService } from '../src/services/metaApiService';
import {
  FIXED_NOW_UNIX,
  RATE_LIMITED_NOTICE_CASES,
  THREAD_TITLE_CASES,
  UNSUPPORTED_NOTICE_CASES,
} from './fixtures/pythonOracle';
import { capturingLogger } from './helpers/network';

const BSUID = 'US.13491208655302741918';
const OTHER_BSUID = 'US.99999999999999999999';
const PHONE = '201234567899';
const NOW = new Date(FIXED_NOW_UNIX * 1000);
const HOUR = 3600;

const baseConfig: ManagerConfig = {
  WA_MAINTENANCE_MODE: false,
  // Production answers a plain message, which is what the tests of everything else send
  DEPLOYMENT_TYPE: 'production',
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
  const ansariClient = options.ansariClient ?? new AnsariClientMock({ logger: log.logger, now: () => clock.now });
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
    createThread: (...args) => inner.createThread(...args),
    deleteThread: (...args) => inner.deleteThread(...args),
    getLastThreadInfo: (...args) => inner.getLastThreadInfo(...args),
    processMessage: (...args) => inner.processMessage(...args),
    ...overrides,
  };
}

/** The mock auth client, with the token exchange replaced. */
function authAnswering(getToken: (bsuid: string) => Promise<string>, forget: (bsuid: string) => void = () => {}): AuthClient {
  return { getToken, forget };
}

/** The thread the mock holds for a user: used to see how many threads a user has. */
async function threadIdOf(ansari: AnsariClient, bsuid: string): Promise<string | null> {
  const token = await new AuthClientMock().getToken(bsuid);
  return (await ansari.getLastThreadInfo(token)).threadId;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('triage: what happens to a message', () => {
  it('answers a text message', () => {
    expect(setup().manager.triage(textMessage())).toBe('text');
  });

  it.each(['image', 'audio', 'errors', 'unsupported'])('says an %s message is unsupported', (messageType) => {
    expect(setup().manager.triage(textMessage({ messageType }))).toBe('unsupported');
  });

  it('puts maintenance mode before age and type', () => {
    const { manager } = setup({ config: { WA_MAINTENANCE_MODE: true, DEPLOYMENT_TYPE: 'production' } });
    // An old image: maintenance still wins
    expect(manager.triage(textMessage({ messageType: 'image', messageUnixTime: 1 }))).toBe('maintenance');
  });

  describe('prefix routing (issue #363): which environment answers', () => {
    const NON_TEXT = { messageType: 'image', messageBody: { id: 'media1' } } as const;
    // [environment, message text or 'non-text', expected]; answers are 'text' (or 'unsupported'), ignored ones 'dev_filter'
    const TABLE: Array<[ManagerConfig['DEPLOYMENT_TYPE'], string, string]> = [
      ['production', 'what is ansari?', 'text'],
      ['production', '!d what is ansari?', 'dev_filter'],
      ['production', '!s what is ansari?', 'dev_filter'],
      ['production', 'non-text', 'unsupported'],
      ['staging', 'what is ansari?', 'dev_filter'],
      ['staging', '!d what is ansari?', 'dev_filter'],
      ['staging', '!s what is ansari?', 'text'],
      ['staging', 'non-text', 'dev_filter'],
      ['local', 'what is ansari?', 'dev_filter'],
      ['local', '!d what is ansari?', 'text'],
      ['local', '!s what is ansari?', 'dev_filter'],
      ['local', 'non-text', 'dev_filter'],
    ];

    it.each(TABLE)('%s, message "%s": %s', (environment, text, expected) => {
      const message = text === 'non-text' ? textMessage(NON_TEXT) : textMessage({}, text);
      expect(setup({ config: { DEPLOYMENT_TYPE: environment } }).manager.triage(message)).toBe(expected);
    });

    it.each(['!d', '!s', '!dx hello', '!sx hello', ' !s hello', '!S hello', '!D hello'])(
      'does not treat "%s" as a prefix: production answers it, staging and development ignore it',
      (text) => {
        expect(setup({ config: { DEPLOYMENT_TYPE: 'production' } }).manager.triage(textMessage({}, text))).toBe('text');
        expect(setup({ config: { DEPLOYMENT_TYPE: 'staging' } }).manager.triage(textMessage({}, text))).toBe('dev_filter');
        expect(setup({ config: { DEPLOYMENT_TYPE: 'local' } }).manager.triage(textMessage({}, text))).toBe('dev_filter');
      },
    );

    // An image caption arrives as `{ body: ... }` too, but only a message of type text carries a prefix
    it('a non-text message has no prefix even when its body looks like one', () => {
      const image = textMessage({ messageType: 'image', messageBody: { body: '!d caption' } });
      expect(setup({ config: { DEPLOYMENT_TYPE: 'local' } }).manager.triage(image)).toBe('dev_filter');
      expect(setup({ config: { DEPLOYMENT_TYPE: 'production' } }).manager.triage(image)).toBe('unsupported');
    });

    it('ignores before the maintenance check, so an ignoring environment never sends its maintenance notice', async () => {
      const t = setup({ config: { WA_MAINTENANCE_MODE: true, DEPLOYMENT_TYPE: 'staging' } });
      expect(await t.handle(textMessage({}, '!d hi'))).toBe('dev_filter');
      expect(await t.handle(textMessage({}, 'hi'))).toBe('dev_filter');
      expect(t.replies()).toEqual([]);
      // The environment that does answer still sends its notice
      expect(await t.handle(textMessage({}, '!s hi'))).toBe('maintenance');
      expect(t.replies()).toEqual([MAINTENANCE_NOTICE]);
    });

    it('ignores a message before the age check, so an old message for another environment is a filter hit', () => {
      const { manager } = setup({ config: { DEPLOYMENT_TYPE: 'staging' } });
      expect(manager.triage(textMessage({ messageUnixTime: 1 }, '!d old'))).toBe('dev_filter');
    });

    it.each([
      ['staging', '!s what is ansari?'],
      ['local', '!d what is ansari?'],
    ] as const)('%s strips the prefix before the text goes to apps/api', async (environment, text) => {
      const sent: string[] = [];
      const inner = new AnsariClientMock({ logger: capturingLogger().logger, now: () => NOW });
      const t = setup({
        config: { DEPLOYMENT_TYPE: environment },
        ansariClient: wrappedAnsari(inner, {
          processMessage: (token, threadId, message) => {
            sent.push(message);
            return inner.processMessage(token, threadId, message);
          },
        }),
      });
      await t.handle(textMessage({}, text));
      expect(sent).toEqual(['what is ansari?']);
    });

    it('production sends a message without a prefix to apps/api unchanged', async () => {
      const sent: string[] = [];
      const inner = new AnsariClientMock({ logger: capturingLogger().logger, now: () => NOW });
      const t = setup({
        config: { DEPLOYMENT_TYPE: 'production' },
        ansariClient: wrappedAnsari(inner, {
          processMessage: (token, threadId, message) => {
            sent.push(message);
            return inner.processMessage(token, threadId, message);
          },
        }),
      });
      await t.handle(textMessage({}, 'what is ansari?'));
      expect(sent).toEqual(['what is ansari?']);
    });

    it('an ignored message is not signed in, answered, logged or reported: no phone, BSUID or text', async () => {
      let exchanges = 0;
      const t = setup({
        config: { DEPLOYMENT_TYPE: 'staging' },
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
      expect(setup({ config: { DEPLOYMENT_TYPE: 'production' } }).manager.triage(message)).toBe('unsupported');
      expect(setup({ config: { DEPLOYMENT_TYPE: 'staging' } }).manager.triage(message)).toBe('dev_filter');
    });

    it('does not crash on a body that is null or a string', () => {
      const { manager } = setup({ config: { DEPLOYMENT_TYPE: 'production' } });
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
    const t = setup({ config: { DEPLOYMENT_TYPE: 'staging' } });
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
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    const record = (...args: unknown[]) => seen.push(JSON.stringify(args));
    const t = setup({
      authClient: authAnswering(async (bsuid) => {
        record('auth', bsuid);
        return mockAuth.getToken(bsuid);
      }),
      ansariClient: wrappedAnsari(inner, {
        createThread: async (...args) => (record('create', ...args), inner.createThread(...args)),
        getLastThreadInfo: async (...args) => (record('list', ...args), inner.getLastThreadInfo(...args)),
        processMessage: async (...args) => (record('chat', ...args), inner.processMessage(...args)),
      }),
    });

    await t.handle(textMessage({ senderPhone: PHONE }, 'a-very-distinctive-question'));

    expect(seen.length).toBeGreaterThanOrEqual(4);
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
describe('a normal answer', () => {
  it('signs in, shows typing, asks apps/api and sends the formatted answer', async () => {
    const t = setup();

    expect(await t.handle(textMessage({}, 'hello there'))).toBe('text');

    // The mock answers "This is a *mock AI assistant* ...", which the formatter turns into WhatsApp italics
    expect(t.replies()).toEqual(['This is a _mock AI assistant_ running in test mode.\n\nYour message: hello there']);
    expect(t.reports).toEqual([]);
  });

  it('formats the answer for WhatsApp before sending it', async () => {
    const answer = '## Title\n\nSome **bold** and *italic* text';
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    const t = setup({ ansariClient: wrappedAnsari(inner, { processMessage: async () => answer }) });

    await t.handle(textMessage());

    expect(t.replies()).toEqual(['*_Title_*\n\nSome *bold* and _italic_ text']);
  });

  it('splits a long answer into parts that each fit WhatsApp, in order', async () => {
    const paragraph = (n: number) => `Paragraph ${n} ${'x'.repeat(1500)}`;
    const answer = [1, 2, 3, 4, 5].map(paragraph).join('\n\n');
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    const t = setup({ ansariClient: wrappedAnsari(inner, { processMessage: async () => answer }) });

    await t.handle(textMessage());

    expect(t.replies().length).toBeGreaterThan(1);
    expect(t.replies().every((part) => [...part].length <= 4000)).toBe(true);
    expect(t.replies().join('\n\n')).toContain('Paragraph 1');
    expect(t.replies().join('\n\n').indexOf('Paragraph 5')).toBeGreaterThan(t.replies().join('\n\n').indexOf('Paragraph 1'));
  });

  it('is the same user across messages: the second message finds the first one\'s thread', async () => {
    const t = setup();
    await t.handle(textMessage({}, 'first'));
    const first = await threadIdOf(t.ansariClient, BSUID);
    await t.handle(textMessage({}, 'second'));
    expect(await threadIdOf(t.ansariClient, BSUID)).toBe(first);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('an answer with nothing to send', () => {
  const notice = "Sorry, we couldn't process your message. Please try again later.";

  async function answerWith(answer: string) {
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    const t = setup({ ansariClient: wrappedAnsari(inner, { processMessage: async () => answer }) });
    await t.handle(textMessage());
    return t;
  }

  it('tells the user when apps/api finished without saying anything', async () => {
    expect((await answerWith('')).replies()).toEqual([notice]);
  });

  // Phase 2 made splitMessage return [] for blank text (Python sent nothing, or spaces WhatsApp refuses). Staying silent
  // would leave the user waiting for nothing, so they get the same notice as for an empty answer.
  it.each(['   ', '\n\n\n', ' \n \t \n', '\u3000'])('tells the user when the answer is only whitespace (%j)', async (blank) => {
    expect((await answerWith(blank)).replies()).toEqual([notice]);
  });

  it('does not report an empty answer as an operator error', async () => {
    expect((await answerWith('')).reports).toEqual([]);
  });

  it('stops the typing indicator for an empty answer too', async () => {
    const t = await answerWith('');
    const sentBefore = t.recipients().length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.recipients().length).toBe(sentBefore);
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
        getLastThreadInfo: async (...args) => (apiCalls++, inner.getLastThreadInfo(...args)),
      }),
      metaApi: {
        sendTypingIndicator: async () => {
          typing += 1;
        },
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
describe('one re-exchange after an apps/api 401', () => {
  /** apps/api refuses the first `refused` chat calls with a 401, then answers from the mock. */
  function apiRefusing(refused: number) {
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    const state = { chatCalls: 0, tokens: [] as string[] };
    const client = wrappedAnsari(inner, {
      processMessage: async (token, threadId, message) => {
        state.chatCalls += 1;
        state.tokens.push(token);
        if (state.chatCalls <= refused) throw new ApiUnauthorizedError("apps/api refused the user's token");
        return inner.processMessage(token, threadId, message);
      },
      // Threads belong to a token in the mock, so a fresh token is a fresh user. Keep one user across tokens.
      getLastThreadInfo: async () => ({ threadId: null, lastMessageTime: null }),
      createThread: async () => ({ threadId: 'mock_thread_fixed' }),
    });
    return { client, state, inner };
  }

  /** An exchange that hands out token-1, token-2, ... and counts calls. */
  function countingExchange() {
    const exchanges: string[] = [];
    const forgotten: string[] = [];
    const client = authAnswering(
      async (bsuid) => {
        exchanges.push(bsuid);
        return `token-${exchanges.length}`;
      },
      (bsuid) => {
        forgotten.push(bsuid);
      },
    );
    return { client, exchanges, forgotten };
  }

  it('drops the stale token, exchanges once more, and answers the message with the fresh token', async () => {
    const api = apiRefusing(1);
    const auth = countingExchange();
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    // After the 401 the retry must reach a thread the fresh token can use
    const t = setup({
      ansariClient: wrappedAnsari(api.client, {
        processMessage: async (token, threadId, message) => {
          api.state.chatCalls += 1;
          api.state.tokens.push(token);
          if (api.state.chatCalls === 1) throw new ApiUnauthorizedError("apps/api refused the user's token");
          return inner.processMessage(token, (await inner.createThread(token, 'x')).threadId, message);
        },
      }),
      authClient: auth.client,
    });

    await t.handle(textMessage());

    expect(auth.exchanges).toEqual([BSUID, BSUID]);
    expect(auth.forgotten).toEqual([BSUID]);
    expect(api.state.tokens).toEqual(['token-1', 'token-2']);
    expect(t.replies()).toHaveLength(1);
    expect(t.replies()[0]).toContain('mock AI assistant');
    expect(t.reports).toEqual([]);
  });

  it('forgets the stale token before asking again, not after', async () => {
    const order: string[] = [];
    const api = apiRefusing(1);
    const t = setup({
      ansariClient: api.client,
      authClient: authAnswering(
        async () => {
          order.push('exchange');
          return `token-${order.length}`;
        },
        () => {
          order.push('forget');
        },
      ),
    });
    await t.handle(textMessage());
    expect(order).toEqual(['exchange', 'forget', 'exchange']);
  });

  it('gives up after a second 401: never a third exchange or a third attempt', async () => {
    const api = apiRefusing(99);
    const auth = countingExchange();
    const t = setup({ ansariClient: api.client, authClient: auth.client });

    await t.handle(textMessage());

    expect(auth.exchanges).toHaveLength(2);
    expect(api.state.chatCalls).toBe(2);
    expect(t.reportedAs()).toEqual(['api_unauthorized_after_reexchange']);
    expect(t.replies()).toEqual(['An error occurred while processing your message. Please try again later.']);
  });

  it('tells a user found banned on the re-exchange so, and does not retry', async () => {
    const api = apiRefusing(99);
    let exchanges = 0;
    const t = setup({
      ansariClient: api.client,
      authClient: authAnswering(async () => {
        exchanges += 1;
        if (exchanges === 1) return 'token-1';
        throw new AuthUserBannedError('403');
      }),
    });

    await t.handle(textMessage());

    expect(api.state.chatCalls).toBe(1);
    expect(t.replies()).toEqual([BANNED_NOTICE]);
  });

  // The user sent one message. A 429 on the second exchange would say "you are sending too quickly", which is false.
  it('does not tell the user they are sending too quickly when the re-exchange is rate limited', async () => {
    const api = apiRefusing(99);
    let exchanges = 0;
    const t = setup({
      ansariClient: api.client,
      authClient: authAnswering(async () => {
        exchanges += 1;
        if (exchanges === 1) return 'token-1';
        throw new AuthRateLimitedError('429', 300);
      }),
    });

    await t.handle(textMessage());

    expect(t.replies()).toEqual([SIGN_IN_FAILED_NOTICE]);
    expect(t.replies()[0]).not.toContain('minutes');
  });

  it('reports a failed re-exchange the same way a failed first exchange is reported', async () => {
    const api = apiRefusing(99);
    let exchanges = 0;
    const t = setup({
      ansariClient: api.client,
      authClient: authAnswering(async () => {
        exchanges += 1;
        if (exchanges === 1) return 'token-1';
        throw new AuthKeyRejectedError('401');
      }),
    });

    await t.handle(textMessage());

    expect(t.reportedAs()).toEqual(['auth_key_rejected']);
    expect(t.replies()).toEqual([SIGN_IN_FAILED_NOTICE]);
  });

  it('does not retry a failure that is not a 401', async () => {
    const exchanges = countingExchange();
    let chatCalls = 0;
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger });
    const t = setup({
      authClient: exchanges.client,
      ansariClient: wrappedAnsari(inner, {
        processMessage: async () => {
          chatCalls += 1;
          throw new MessageProcessingError('apps/api is down');
        },
      }),
    });

    await t.handle(textMessage());

    expect(chatCalls).toBe(1);
    expect(exchanges.exchanges).toHaveLength(1);
  });

  it('a 401 while listing threads is retried too, not only one on the chat call', async () => {
    let listCalls = 0;
    const auth = countingExchange();
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    const t = setup({
      authClient: auth.client,
      ansariClient: wrappedAnsari(inner, {
        getLastThreadInfo: async (token) => {
          listCalls += 1;
          if (listCalls === 1) throw new ApiUnauthorizedError('refused');
          return inner.getLastThreadInfo(token);
        },
      }),
    });

    await t.handle(textMessage());

    expect(auth.exchanges).toHaveLength(2);
    expect(t.replies()[0]).toContain('mock AI assistant');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the user\'s one thread', () => {
  async function userThreads(ansari: AnsariClientMock, bsuid: string): Promise<string[]> {
    const token = await new AuthClientMock().getToken(bsuid);
    // The mock lists only the newest thread, so count them by probing each id it may have made
    const ids: string[] = [];
    for (let n = 1; n <= 20; n++) {
      const id = `mock_thread_${n}`;
      try {
        await ansari.processMessage(token, id, '');
        ids.push(id);
      } catch {
        // not this user's, or not there
      }
    }
    return ids;
  }

  function withMock(config: Partial<ManagerConfig> = {}) {
    const log = capturingLogger();
    const clock = { now: NOW };
    const ansari = new AnsariClientMock({ logger: log.logger, now: () => clock.now });
    const t = setup({ ansariClient: ansari, clock, config });
    return { ...t, ansari, clock };
  }

  it('creates the only thread on the first message', async () => {
    const t = withMock();
    await t.handle(textMessage());
    expect(await userThreads(t.ansari, BSUID)).toEqual(['mock_thread_1']);
  });

  it('reuses the thread inside the expiry and keeps its history', async () => {
    const t = withMock();
    await t.handle(textMessage({}, 'remember me'));
    t.clock.now = new Date(NOW.getTime() + (3 * HOUR - 60) * 1000); // just inside
    await t.handle(textMessage({}, 'hello again'));
    expect(await userThreads(t.ansari, BSUID)).toEqual(['mock_thread_1']);
  });

  it('deletes the old thread and starts a new one after the expiry', async () => {
    const t = withMock();
    await t.handle(textMessage({}, 'old message'));
    t.clock.now = new Date(NOW.getTime() + (3 * HOUR + 60) * 1000); // just outside
    await t.handle(textMessage({}, 'hello again'));
    expect(await userThreads(t.ansari, BSUID)).toEqual(['mock_thread_2']);
  });

  it('reads the expiry from the settings', async () => {
    const t = withMock({ WHATSAPP_CHAT_RETENTION_HOURS: 1 });
    await t.handle(textMessage());
    t.clock.now = new Date(NOW.getTime() + (HOUR + 60) * 1000);
    await t.handle(textMessage());
    expect(await userThreads(t.ansari, BSUID)).toEqual(['mock_thread_2']);
  });

  it('treats a thread exactly at the retention time as still current', async () => {
    const t = withMock();
    await t.handle(textMessage());
    t.clock.now = new Date(NOW.getTime() + 3 * HOUR * 1000);
    await t.handle(textMessage());
    expect(await userThreads(t.ansari, BSUID)).toEqual(['mock_thread_1']);
  });

  it('never touches another user\'s thread', async () => {
    const t = withMock();
    await t.handle(textMessage({ bsuid: OTHER_BSUID }));
    await t.handle(textMessage());
    t.clock.now = new Date(NOW.getTime() + (3 * HOUR + 60) * 1000);
    await t.handle(textMessage());
    expect(await userThreads(t.ansari, OTHER_BSUID)).toEqual(['mock_thread_1']);
  });

  // apps/api sends `...Z`, while the mock stores its own format, so this is the form production depends on
  describe('with the timestamp apps/api really sends', () => {
    function calls(info: ThreadInfo, options: { failDelete?: boolean } = {}) {
      const log: string[] = [];
      const client: AnsariClient = {
        getLastThreadInfo: async () => info,
        deleteThread: async (_token, id) => {
          log.push(`delete ${id}`);
          if (options.failDelete) throw new ThreadDeletionError('apps/api is down');
        },
        createThread: async (_token, title) => {
          log.push(`create ${title}`);
          return { threadId: 'new' };
        },
        processMessage: async (_token, id) => {
          log.push(`chat ${id}`);
          return 'ok';
        },
      };
      return { client, log };
    }
    const fourHoursAgo = new Date(NOW.getTime() - 4 * HOUR * 1000).toISOString();

    it('reads a Z timestamp: deletes the expired thread, then creates one titled by the first words', async () => {
      const { client, log } = calls({ threadId: 'old', lastMessageTime: fourHoursAgo });
      const t = setup({ ansariClient: client });
      await t.handle(textMessage({}, 'hello there'));
      expect(log).toEqual(['delete old', 'create hello there', 'chat new']);
    });

    it('reads a +00:00 timestamp and one with an offset', async () => {
      for (const stamp of ['2026-11-10T08:00:00.000+00:00', '2026-11-10T10:00:00+02:00']) {
        const { client, log } = calls({ threadId: 'old', lastMessageTime: stamp });
        await setup({ ansariClient: client }).handle(textMessage());
        expect(log).toEqual(['delete old', 'create hello', 'chat new']);
      }
    });

    it('keeps a thread whose Z timestamp is recent', async () => {
      const { client, log } = calls({ threadId: 'cur', lastMessageTime: new Date(NOW.getTime() - 60_000).toISOString() });
      await setup({ ansariClient: client }).handle(textMessage());
      expect(log).toEqual(['chat cur']);
    });

    it('starts a thread when there is none', async () => {
      const { client, log } = calls({ threadId: null, lastMessageTime: null });
      await setup({ ansariClient: client }).handle(textMessage());
      expect(log).toEqual(['create hello', 'chat new']);
    });

    it('creates a thread without deleting when a thread exists but has no time', async () => {
      const { client, log } = calls({ threadId: 'odd', lastMessageTime: null });
      await setup({ ansariClient: client }).handle(textMessage());
      expect(log).toEqual(['delete odd', 'create hello', 'chat new']);
    });

    // JavaScript would read this as local time and move the thread by the server's offset; Python refused it
    it.each(['2026-11-10T08:00:00', '2026-11-10', 'yesterday', ''])('refuses a timestamp without a time zone (%j) rather than guessing', async (stamp) => {
      const { client, log } = calls({ threadId: 'old', lastMessageTime: stamp });
      const t = setup({ ansariClient: client });
      await t.handle(textMessage());
      expect(log).toEqual([]);
      expect(t.replies()).toEqual(['An unexpected error occurred while processing your message. Please try again later.']);
    });
  });

  describe('the thread title', () => {
    it.each(THREAD_TITLE_CASES)('titles a thread from %j as Python did', async (message, python) => {
      const titles: string[] = [];
      const client: AnsariClient = {
        getLastThreadInfo: async () => ({ threadId: null, lastMessageTime: null }),
        deleteThread: async () => {},
        createThread: async (_token, title) => {
          titles.push(title);
          return { threadId: 'new' };
        },
        processMessage: async () => 'ok',
      };
      await setup({ ansariClient: client }).handle(textMessage({}, message));
      expect(titles).toEqual([python]);
    });
  });

  describe('failures, each reported under its own name', () => {
    function failing(overrides: Partial<AnsariClient>) {
      const log = capturingLogger();
      const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
      return setup({ ansariClient: wrappedAnsari(inner, overrides) });
    }

    it('a failed thread list is reported, and the user is told about chat history', async () => {
      const t = failing({
        getLastThreadInfo: async () => {
          throw new ThreadInfoError('apps/api is down');
        },
      });
      await t.handle(textMessage());
      expect(t.reportedAs()).toEqual(['thread_info_failure']);
      expect(t.replies()).toEqual(["Sorry, we're having trouble accessing your chat history. Please try again later."]);
    });

    it('a failed delete is reported, the user is told, and no second thread is created', async () => {
      const log = capturingLogger();
      const clock = { now: NOW };
      const inner = new AnsariClientMock({ logger: log.logger, now: () => clock.now });
      let creates = 0;
      const t = setup({
        clock,
        ansariClient: wrappedAnsari(inner, {
          deleteThread: async () => {
            throw new ThreadDeletionError('apps/api is down');
          },
          createThread: async (...args) => (creates++, inner.createThread(...args)),
        }),
      });
      await t.handle(textMessage());
      expect(creates).toBe(1);
      clock.now = new Date(NOW.getTime() + (3 * HOUR + 60) * 1000);

      await t.handle(textMessage());

      expect(creates).toBe(1); // still exactly one thread
      expect(t.reportedAs()).toEqual(['thread_deletion_failure']);
      expect(t.replies().at(-1)).toBe('An unexpected error occurred while starting a new chat session.. Please try again later.');
    });

    it('a failed create is reported and the user is told', async () => {
      const t = failing({
        createThread: async () => {
          throw new ThreadCreationError('apps/api is down');
        },
      });
      await t.handle(textMessage());
      expect(t.reportedAs()).toEqual(['thread_creation_failure']);
      expect(t.replies()).toEqual(['An unexpected error occurred while creating a new chat session. Please try again later.']);
    });

    it('a failed chat call is reported and the user is told', async () => {
      const t = failing({
        processMessage: async () => {
          throw new MessageProcessingError('stream cut off');
        },
      });
      await t.handle(textMessage());
      expect(t.reportedAs()).toEqual(['message_processing_failure']);
      expect(t.replies()).toEqual(['An error occurred while processing your message. Please try again later.']);
    });

    it('an unexpected fault gets the "unexpected" notice, is logged, and is not an uncaught error', async () => {
      const t = failing({
        processMessage: async () => {
          throw new RangeError('a bug');
        },
      });
      await t.handle(textMessage());
      expect(t.replies()).toEqual(['An unexpected error occurred while processing your message. Please try again later.']);
      expect(t.log.lines().some((line) => line.level === 'error' && line.message.includes('Unexpected error processing'))).toBe(true);
    });

    it('a text message without a body gets the "unexpected" notice', async () => {
      const t = setup();
      await t.manager.dispatch(textMessage({ messageBody: { nothing: true } }), 'text');
      expect(t.replies()).toEqual(['An unexpected error occurred while processing your message. Please try again later.']);
    });

    it('reports a thread failure with the request id and nothing else identifying', async () => {
      const t = failing({
        getLastThreadInfo: async () => {
          throw new ThreadInfoError('apps/api is down');
        },
      });
      await runWithRequestId('req-9', () => t.handle(textMessage({}, 'a-very-distinctive-question')));
      expect(t.reports[0]!.report.context).toEqual({ request_id: 'req-9' });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('sending', () => {
  it('survives Meta refusing the answer: logs it and does not throw', async () => {
    const metaApi: MetaApiService = {
      sendTypingIndicator: async () => {},
      sendMessage: async () => {
        throw new MetaApiError('Meta said no', 400);
      },
    };
    const t = setup({ metaApi });
    await expect(t.handle(textMessage())).resolves.toBe('text');
    expect(t.log.lines().some((line) => line.level === 'error' && line.message.includes('Error sending WhatsApp message'))).toBe(true);
  });

  it('survives Meta refusing a notice', async () => {
    const metaApi: MetaApiService = {
      sendTypingIndicator: async () => {},
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
    const inner = new AnsariClientMock({ logger: log.logger, now: () => NOW });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { release: () => release(), client: wrappedAnsari(inner, { processMessage: async (...args) => (await gate, inner.processMessage(...args)) }) };
  }

  function typingCounter() {
    const state = { typing: 0, ids: [] as string[] };
    const metaApi = new MetaApiServiceMock({ logger: capturingLogger().logger, delayMs: 0 });
    const counting: MetaApiService = {
      sendTypingIndicator: async (recipient, messageId) => {
        state.typing += 1;
        state.ids.push(`${recipient}/${messageId}`);
      },
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
        processMessage: async () => {
          throw new MessageProcessingError('boom');
        },
      }),
    });
    await t.handle(textMessage());
    const atFinish = counter.state.typing;
    await wait(60);
    expect(counter.state.typing).toBe(atFinish);
  });

  it('stops when a thread step fails', async () => {
    const counter = typingCounter();
    const log = capturingLogger();
    const inner = new AnsariClientMock({ logger: log.logger });
    const t = setup({
      metaApi: counter.counting,
      typingIntervalMs: 10,
      ansariClient: wrappedAnsari(inner, {
        getLastThreadInfo: async () => {
          throw new ThreadInfoError('boom');
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
        processMessage: async () => {
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
