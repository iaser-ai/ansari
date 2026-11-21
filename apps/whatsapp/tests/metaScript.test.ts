/**
 * The operator script: the safety rules, the menu, and whole sessions, against a stand-in for Meta with scripted answers.
 *
 * The screens are not compared with the legacy Python script's output: that comparison, and the recordings it used, were
 * removed. The tests below check behaviour: what is asked, what is changed, and what is never shown.
 *
 * Where the TypeScript script deliberately differs from the legacy one, the test says so:
 * - the unsubscribe safety check matches the token's app by ID, not by name (see its describe block);
 * - the access token is never printed (a test runs a whole session and searches every line and prompt for it).
 *
 * Times print in the machine's local time, so these tests fix the time zone to UTC.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askMenuChoice,
  currentContext,
  formatLocalTime,
  runScript,
  showTokenDetails,
  subscribe,
  unsubscribe,
} from '../scripts/checkMetaSubscriptions';
import type { MetaContext } from '../scripts/metaSubscriptions';
import { json, metaStandIn, scriptedIo, type MetaAnswer } from './helpers/scriptedIo';

/** A made-up token of the same shape as a real one's length; it is never sent anywhere but the stand-in. */
const TOKEN = 'EAAGtestTokenNotReal0123456789abcdefghijklmnop';
const WABA = '111';
const VERSION = 'v26.0';

let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

function setup(answers: MetaAnswer[], inputs: Array<string | null> = []) {
  const meta = metaStandIn(TOKEN, VERSION, answers);
  const io = scriptedIo(inputs);
  const context: MetaContext = { accessToken: TOKEN, wabaId: WABA, version: VERSION, fetch: meta.fetch };
  return { meta, io, context };
}

// ---------------------------------------------------------------------------------------------------------------------
// The answers Meta gives in these tests
// ---------------------------------------------------------------------------------------------------------------------

const APPS = {
  data: [
    { whatsapp_business_api_data: { id: '1', name: 'Ansari - Staging', link: 'https://www.facebook.com/games/?app_id=1' } },
    { whatsapp_business_api_data: { id: '2', name: 'WA DevX Webhook Events 1P App' } },
  ],
};
const ONE_APP = { data: [{ whatsapp_business_api_data: { id: '1', name: 'Ansari - Staging' } }] };
const TOKEN_DETAILS = {
  data: {
    app_id: '1',
    application: 'Ansari - Staging',
    type: 'SYSTEM_USER',
    is_valid: true,
    issued_at: 1700000000,
    expires_at: 0,
    data_access_expires_at: 1800000000,
    user_id: '77',
    scopes: ['whatsapp_business_messaging', 'business_management'],
    granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['111'] }, 'plain'],
    metadata: { sso: 'none', n: 1 },
    extra_field: { a: [1, null, true] },
  },
};
const tok = (id: string, name: string) => () => json(200, { data: { app_id: id, application: name } });
const ok = (body: unknown) => () => json(200, body);
const bad = (status: number, body: unknown) => () => json(status, body);

describe('the menu', () => {
  it('rejects a bad choice and an out-of-range one, and trims spaces', async () => {
    const { io, context } = setup([json(200, { name: 'Test WABA' }), json(200, { data: { application: 'Ansari - Staging' } })], ['x', '10', ' 3 ']);

    expect(await askMenuChoice(io, context)).toBe('3');
    expect(io.lines.filter((line) => line.includes('Invalid choice'))).toHaveLength(2);
  });

  it.each(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])('accepts %s', async (digit) => {
    const { io, context } = setup([json(200, { name: 'W' }), json(200, { data: { application: 'A' } })], [digit]);
    expect(await askMenuChoice(io, context)).toBe(digit);
  });

  it.each(['', '-1', '01', 'a', '3x', '１'])('refuses %j and asks again', async (typed) => {
    const { io, context } = setup([json(200, { name: 'W' }), json(200, { data: { application: 'A' } })], [typed, '9']);
    expect(await askMenuChoice(io, context)).toBe('9');
    expect(io.lines).toContain('   Invalid choice. Please enter a number between 0 and 9.');
  });

  it('treats the end of input as "exit", as Python treated Ctrl+C', async () => {
    const { io, context } = setup([json(200, { name: 'W' }), json(200, { data: { application: 'A' } })], [null]);
    expect(await askMenuChoice(io, context)).toBe('9');
    expect(io.lines).toContain('Interrupted by user. Exiting...');
  });

  describe('the context box', () => {
    it('shows the WABA and app names when Meta gives them', async () => {
      const { context } = setup([json(200, { name: 'Test WABA' }), json(200, { data: { application: 'Ansari - Staging' } })]);
      const result = await currentContext(context);
      expect([result.wabaName, result.appName]).toEqual(['Test WABA', 'Ansari - Staging']);
    });

    it('with no name in the WABA answer, says the WABA ID is probably wrong, and does not stop', async () => {
      const { context } = setup([json(200, {}), json(200, { data: {} })]);
      const result = await currentContext(context);
      expect(result.wabaName).toBe('Unknown (probably invalid WABA ID)');
      expect(result.appName).toBe('Unknown (probably invalid token)');
    });

    it('with no data in the app answer, shows "Unknown" for the app and keeps the WABA name', async () => {
      const { context } = setup([json(200, { name: 'W' }), json(200, {})]);
      const result = await currentContext(context);
      expect([result.wabaName, result.appName]).toEqual(['W', 'Unknown']);
    });

    it('with both calls refused, shows "Unknown" for both', async () => {
      const { context } = setup([json(400, {}), json(400, {})]);
      const result = await currentContext(context);
      expect([result.wabaName, result.appName]).toEqual(['Unknown', 'Unknown']);
    });

    it('keeps "Unknown" when Meta cannot be reached at all', async () => {
      const { context } = setup([new TypeError('fetch failed'), new TypeError('fetch failed')]);
      expect(await currentContext(context)).toEqual({ wabaName: 'Unknown', appName: 'Unknown' });
    });
  });
});

describe('the unsubscribe safety check: the token\'s own app, matched by ID', () => {
  it('refuses when a subscribed app has the token app\'s NAME but another ID, and never asks to confirm or deletes', async () => {
    const sameName = { data: [{ whatsapp_business_api_data: { id: '2', name: 'Ansari - Staging' } }] };
    const { meta, io, context } = setup([tok('1', 'Ansari - Staging')(), json(200, { name: 'Test WABA' }), json(200, sameName)]);

    expect(await unsubscribe(io, context)).toBe(false);

    expect(meta.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
    expect(io.prompts).toEqual([]);
    const screen = io.lines.join('\n');
    expect(screen).toContain("WARNING: Your access token's app is NOT in the subscribed list!");
    expect(screen).toContain('Your token is for: Ansari - Staging (ID: 1)');
    expect(screen).toContain('Cannot proceed with unsubscription.');
    expect(screen).not.toContain('Match found');
  });

  it('when the token app was renamed (the ID still matches), goes on and asks', async () => {
    const { meta, io, context } = setup([tok('1', 'Renamed')(), json(200, { name: 'Test WABA' }), json(200, ONE_APP)], ['no']);

    expect(await unsubscribe(io, context)).toBe(false);

    expect(io.lines.join('\n')).toContain('Match found: Renamed app is subscribed to Test WABA WABA');
    expect(io.prompts.map((p) => p.text)).toEqual(['\n   Are you sure you want to proceed? (yes/no): ']);
    expect(meta.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('refuses when the token\'s ID cannot be read', async () => {
    const { meta, io, context } = setup([json(200, { data: { application: 'Ansari - Staging' } }), json(200, { name: 'W' }), json(200, ONE_APP)]);
    expect(await unsubscribe(io, context)).toBe(false);
    expect(meta.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(io.prompts).toEqual([]);
  });

  it('deletes only after the operator types yes, and only with the token\'s own bearer, no app named in the call', async () => {
    const { meta, io, context } = setup([tok('1', 'Ansari - Staging')(), json(200, { name: 'W' }), json(200, APPS), json(200, { success: true })], ['yes']);

    expect(await unsubscribe(io, context)).toBe(true);

    const deletes = meta.calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toEqual([{ method: 'DELETE', path: '/111/subscribed_apps', query: '', bearer: true, redirect: 'manual' }]);
    expect(io.lines.join('\n')).toContain('Other subscribed apps will remain unaffected: WA DevX Webhook Events 1P App');
  });

  it.each(['', 'no', 'n', 'YES please', 'ye', 'yes!', null])('does not delete when the answer is %j', async (answer) => {
    const { meta, io, context } = setup([tok('1', 'Ansari - Staging')(), json(200, { name: 'W' }), json(200, APPS)], [answer]);
    expect(await unsubscribe(io, context)).toBe(false);
    expect(meta.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(io.lines).toContain('   Unsubscription cancelled.');
  });

  it('does not delete when Meta lists nothing, or the token cannot be read, or the list fails', async () => {
    for (const answers of [
      [tok('1', 'A')(), json(200, { name: 'W' }), json(200, { data: [] })],
      [json(200, {})],
      [tok('1', 'A')(), json(200, { name: 'W' }), json(500, {})],
      [new TypeError('fetch failed')],
    ]) {
      const { meta, io, context } = setup(answers);
      expect(await unsubscribe(io, context)).toBe(false);
      expect(meta.calls.some((call) => call.method === 'DELETE')).toBe(false);
    }
  });
});

describe('subscribing changes Meta only after yes', () => {
  it.each(['', 'no', 'n', 'y', 'sure', null])('does not call Meta when the answer is %j', async (answer) => {
    const { meta, io, context } = setup([], [answer]);
    expect(await subscribe(io, context)).toBe(false);
    expect(meta.calls).toEqual([]);
    expect(io.lines).toContain('   Subscription cancelled.');
  });

  it('posts once, with the token as the bearer and no app named, after yes', async () => {
    const { meta, io, context } = setup([json(200, { success: true })], ['yes']);
    expect(await subscribe(io, context)).toBe(true);
    expect(meta.calls).toEqual([{ method: 'POST', path: '/111/subscribed_apps', query: '', bearer: true, redirect: 'manual' }]);
  });
});

describe('the access token is never shown', () => {
  it('is in no line and no prompt of a session that visits every option and meets errors that echo it', async () => {
    const echoing = bad(400, { error: { message: `Invalid OAuth access token ${TOKEN} for app` } });
    const ctx = () => [json(200, { name: 'Test WABA' }), json(200, { data: { application: 'Ansari - Staging' } })];
    const meta = metaStandIn(TOKEN, VERSION, [
      ...ctx(), // menu
      ...[ok({ id: '111', name: 'W' })()], // option 1
      ...ctx(),
      ...[echoing()], // option 2 fails with the token in Meta's text
      ...ctx(),
      ...[ok(APPS)()], // option 3
      ...ctx(),
      ...[new TypeError(`fetch failed for ${TOKEN}`)], // option 4: a network error whose text holds the token
      ...ctx(),
      ...[tok('1', 'Ansari - Staging')(), json(200, { name: 'W' }), json(200, APPS), echoing()], // option 6, then DELETE fails echoing it
      ...ctx(),
    ]);
    const io = scriptedIo(['1', '', '2', '', '3', '', '4', '', '6', 'yes', '', '9']);

    await runScript(io, {
      env: { META_ACCESS_TOKEN_FROM_SYS_USER: TOKEN, META_MESSAGING_ACCOUNT_ID: WABA },
      envFileFound: true,
      fetch: meta.fetch,
    });

    const everything = [...io.lines, ...io.prompts.map((p) => p.text)].join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(TOKEN.slice(0, 12));
    expect(everything).toContain('***'); // where Meta's text echoed it
    expect(io.lines).toContain(`   Access Token: set (${TOKEN.length} characters, never shown)`);
    expect(io.remaining()).toBe(0);
  });

  it('is also cut out of an error the script itself raises, such as a time field that holds the token', async () => {
    // Meta's answer is odd on purpose: `issued_at` is the token, so formatting it as a time raises an error whose text names it
    const { io, context } = setup([json(200, { data: { issued_at: TOKEN } })]);
    await showTokenDetails(io, context);
    const everything = io.lines.join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain('Error: a timestamp must be a number, got ');
    expect(everything).toContain('***');
  });
});

describe('a whole session', () => {
  const ENV = { META_ACCESS_TOKEN_FROM_SYS_USER: TOKEN, META_MESSAGING_ACCOUNT_ID: WABA };
  const menuAnswers = () => [json(200, { name: 'Test WABA' }), json(200, { data: { application: 'Ansari - Staging' } })];

  async function session(answers: MetaAnswer[], inputs: Array<string | null>, options: { env?: Record<string, string | undefined>; envFileFound?: boolean } = {}) {
    const meta = metaStandIn(TOKEN, VERSION, answers);
    const io = scriptedIo(inputs);
    await runScript(io, { env: options.env ?? ENV, envFileFound: options.envFileFound ?? true, fetch: meta.fetch });
    return { io, meta };
  }

  it('starts with the title and the configuration, then the menu, and exits on 9', async () => {
    const { io, meta } = await session(menuAnswers(), ['9']);
    expect(io.lines.slice(0, 3)).toEqual(['='.repeat(60), 'WhatsApp Business Account Subscription Manager', '='.repeat(60)]);
    expect(io.lines).toContain('   WABA ID: 111');
    expect(io.lines.slice(-3)).toEqual(['='.repeat(60), 'Done! Exiting...', '='.repeat(60)]);
    expect(meta.calls.map((call) => call.path)).toEqual(['/111', '/debug_token']);
  });

  it('after an option, Enter returns to the menu and q quits', async () => {
    const back = await session([...menuAnswers(), ...[json(200, { data: [] })], ...menuAnswers()], ['3', '', '9']);
    expect(back.io.prompts.map((p) => p.text)).toContain("\n   Press Enter to return to menu (or 'q' to quit): ");
    expect(back.meta.calls.filter((call) => call.path === '/111/subscribed_apps')).toHaveLength(1);

    const quit = await session([...menuAnswers(), json(200, { data: [] })], ['3', ' Q ']);
    expect(quit.io.lines).toContain('Done! Exiting...');
    expect(quit.io.remaining()).toBe(0);
  });

  it('quits cleanly when the input ends in the middle of the "press Enter" question', async () => {
    const { io } = await session([...menuAnswers(), json(200, { data: [] })], ['3', null]);
    expect(io.lines).toContain('Done! Exiting...');
  });

  it('option 7 runs the four checks in order: details, token, apps, phones', async () => {
    const { meta } = await session(
      [...menuAnswers(), json(200, { id: '111' }), json(200, TOKEN_DETAILS), json(200, APPS), json(200, { data: [] }), ...menuAnswers()],
      ['7', '', '9'],
    );
    expect(meta.calls.map((call) => call.path).slice(2, 6)).toEqual(['/111', '/debug_token', '/111/subscribed_apps', '/111/phone_numbers']);
  });

  // Python: `if choice not in ("8", "9")` asks "press Enter or q" after every option except 8 and 9, so option 0 asks it too
  it('options 0 and 8 each wait for Enter; only option 8 skips the "press Enter or q" question', async () => {
    const { io } = await session([...menuAnswers(), ...menuAnswers(), ...menuAnswers()], ['0', '', '', '8', '', '9']);
    const asked = io.prompts.map((p) => p.text);
    expect(asked.filter((text) => text === '\nPress Enter to return to menu...')).toHaveLength(2);
    expect(asked.filter((text) => text.includes("(or 'q' to quit)"))).toHaveLength(1);
    expect(io.remaining()).toBe(0);
  });

  it('option 5 subscribes after yes and then shows the new list; after no it changes nothing and shows nothing', async () => {
    const yes = await session([...menuAnswers(), json(200, { success: true }), json(200, ONE_APP), ...menuAnswers()], ['5', 'yes', '', '9']);
    expect(yes.meta.calls.map((call) => `${call.method} ${call.path}`).slice(2, 4)).toEqual(['POST /111/subscribed_apps', 'GET /111/subscribed_apps']);
    expect(yes.io.lines).toContain('   → Verifying subscription...');

    const no = await session([...menuAnswers(), ...menuAnswers()], ['5', 'no', '', '9']);
    expect(no.meta.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(no.io.lines).not.toContain('   → Verifying subscription...');
  });

  it('option 6 removes after yes and then shows the new list; when it refuses it changes nothing', async () => {
    const yes = await session(
      [...menuAnswers(), tok('1', 'Ansari - Staging')(), json(200, { name: 'W' }), json(200, APPS), json(200, { success: true }), json(200, { data: [] }), ...menuAnswers()],
      ['6', 'yes', '', '9'],
    );
    expect(yes.io.lines).toContain('   → Verifying unsubscription...');
    expect(yes.meta.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);

    const refused = await session([...menuAnswers(), tok('9', 'Other')(), json(200, { name: 'W' }), json(200, APPS), ...menuAnswers()], ['6', '', '9']);
    expect(refused.meta.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(refused.io.lines).not.toContain('   → Verifying unsubscription...');
  });

  it('every call goes to Meta\'s Graph API at the configured version, carries the bearer token, and refuses redirects', async () => {
    const seen: string[] = [];
    const recording = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(`${String(input)}|${new Headers(init?.headers).get('authorization')}|${init?.redirect}`);
      return json(200, { name: 'W', data: { application: 'A' } });
    }) as typeof fetch;
    const io = scriptedIo(['9']);

    await runScript(io, { env: { ...ENV, META_API_VERSION: 'v99.1' }, envFileFound: true, fetch: recording });

    expect(seen).toHaveLength(2);
    for (const entry of seen) {
      expect(entry.startsWith('https://graph.facebook.com/v99.1/')).toBe(true);
      expect(entry.endsWith(`|Bearer ${TOKEN}|manual`)).toBe(true);
    }
  });

  it('defaults to v26.0 when META_API_VERSION is unset or empty', async () => {
    for (const version of [undefined, '']) {
      const seen: string[] = [];
      const recording = (async (input: Parameters<typeof fetch>[0]) => {
        seen.push(String(input));
        return json(200, {});
      }) as typeof fetch;
      await runScript(scriptedIo(['9']), { env: { ...ENV, META_API_VERSION: version }, envFileFound: true, fetch: recording });
      expect(seen[0]).toContain('/v26.0/');
    }
  });

  describe('when something is missing', () => {
    it('with no .env and nothing set, offers manual entry and stops on no, calling nothing', async () => {
      const { io, meta } = await session([], ['no'], { env: {}, envFileFound: false });
      expect(io.lines).toContain('   No .env file found in the current directory');
      expect(io.lines).toContain('      META_ACCESS_TOKEN_FROM_SYS_USER=your_token_here');
      expect(meta.calls).toEqual([]);
    });

    it('with no .env, asks for the token HIDDEN and the account id in plain view', async () => {
      const { io } = await session(menuAnswers(), ['yes', TOKEN, WABA, '9'], { env: {}, envFileFound: false });
      const tokenPrompt = io.prompts.find((p) => p.text.includes('META_ACCESS_TOKEN_FROM_SYS_USER (typing is hidden)'));
      expect(tokenPrompt?.hidden).toBe(true);
      expect(io.prompts.find((p) => p.text.includes('Enter your WABA ID'))?.hidden).toBe(false);
      expect([...io.lines, ...io.prompts.map((p) => p.text)].join('\n')).not.toContain(TOKEN);
    });

    it('with a .env that lacks the token, asks for it hidden', async () => {
      const { io } = await session(menuAnswers(), [TOKEN, '9'], { env: { META_MESSAGING_ACCOUNT_ID: WABA } });
      expect(io.lines).toContain('→ Access Token Configuration');
      expect(io.prompts[0]).toEqual({ text: '\n   Enter your META_ACCESS_TOKEN_FROM_SYS_USER (typing is hidden): ', hidden: true });
    });

    it('with real environment variables but no .env file, uses them without asking (Python ignored them)', async () => {
      const { io } = await session(menuAnswers(), ['9'], { env: ENV, envFileFound: false });
      expect(io.lines).not.toContain('   No .env file found in the current directory');
    });

    it('with a .env that lacks the account id, explains where to find it and asks', async () => {
      const { io } = await session(menuAnswers(), [WABA, '9'], { env: { META_ACCESS_TOKEN_FROM_SYS_USER: TOKEN } });
      expect(io.lines).toContain('→ WABA ID Configuration');
      expect(io.prompts[0]!.text).toBe('\n   Enter your WABA ID: ');
    });

    it.each([
      ['an empty token', [''], '   ERROR: Access token is required. Exiting...', { META_MESSAGING_ACCOUNT_ID: WABA }],
      ['a blank token', ['   '], '   ERROR: Access token is required. Exiting...', { META_MESSAGING_ACCOUNT_ID: WABA }],
      ['no token (input ended)', [null], '   ERROR: Access token is required. Exiting...', { META_MESSAGING_ACCOUNT_ID: WABA }],
      ['an empty account id', [''], '   ERROR: WABA ID is required. Exiting...', { META_ACCESS_TOKEN_FROM_SYS_USER: TOKEN }],
      ['no account id (input ended)', [null], '   ERROR: WABA ID is required. Exiting...', { META_ACCESS_TOKEN_FROM_SYS_USER: TOKEN }],
    ] as const)('stops with a message for %s, calling nothing', async (_name, inputs, message, env) => {
      const { io, meta } = await session([], [...inputs], { env });
      expect(io.lines).toContain(message);
      expect(meta.calls).toEqual([]);
    });

    it('trims what is typed for the token and the account id', async () => {
      const { meta } = await session(menuAnswers(), [`  ${TOKEN}  `, `  ${WABA}  `, '9'], { env: {} , envFileFound: true });
      expect(meta.calls[0]!.path).toBe('/111');
      expect(meta.calls[0]!.bearer).toBe(true);
    });
  });
});

describe('formatLocalTime (Python: str(datetime.fromtimestamp(...)) in local time)', () => {
  it.each([
    [0, '1970-01-01 00:00:00'],
    [1700000000, '2023-11-14 22:13:20'],
    [1800000000, '2027-01-15 08:00:00'],
    [1900000000, '2030-03-17 17:46:40'],
    [86399, '1970-01-01 23:59:59'],
    [1700000000.9, '2023-11-14 22:13:20'],
  ])('%s -> %s', (seconds, text) => {
    expect(formatLocalTime(seconds)).toBe(text);
  });

  it('follows the machine\'s time zone, as Python did', () => {
    const before = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      expect(formatLocalTime(1700000000)).toBe('2023-11-15 07:13:20');
    } finally {
      process.env.TZ = before ?? 'UTC';
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '1700000000' as unknown as number])('refuses %j instead of printing a wrong date', (value) => {
    expect(() => formatLocalTime(value)).toThrow(TypeError);
  });

  it('is what the token screen shows for the issue and expiry times', async () => {
    const { io, context } = setup([ok(TOKEN_DETAILS)()]);
    await showTokenDetails(io, context);
    const screen = io.lines.join('\n');
    expect(screen).toContain(`Issued At: ${formatLocalTime(1700000000)} (1700000000)`);
    expect(screen).toContain(`Data Access Expires At: ${formatLocalTime(1800000000)} (1800000000)`);
  });
});
