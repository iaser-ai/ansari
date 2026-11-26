/**
 * The Graph API layer of the operator script: how each call is made, how failures read, and how Meta's answers are understood.
 *
 * Python counterpart: none. The legacy script called `requests` inline in each function and had no timeout, no redirect rule and
 * no limit on what an error could print.
 */
import { describe, expect, it } from 'vitest';
import {
  debugToken,
  getPhoneNumbers,
  getSubscribedApps,
  getWabaDetails,
  getWabaName,
  MetaCallError,
  planUnsubscribe,
  pythonShow,
  readSubscribedApps,
  readTokenApp,
  subscribeTokenApp,
  unsubscribeTokenApp,
  withoutToken,
  type MetaContext,
  type SubscribedApp,
} from '../scripts/metaSubscriptions';
import { json, metaStandIn, type MetaAnswer } from './helpers/scriptedIo';

const TOKEN = 'EAAMf-token-0123456789-abcdef';

function ctx(answers: MetaAnswer[], overrides: Partial<MetaContext> = {}) {
  const meta = metaStandIn(TOKEN, 'v26.0', answers);
  const context: MetaContext = { accessToken: TOKEN, wabaId: '111', version: 'v26.0', fetch: meta.fetch, ...overrides };
  return { context, meta };
}

async function thrown(promise: Promise<unknown>): Promise<MetaCallError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MetaCallError);
    return error as MetaCallError;
  }
  throw new Error('expected the call to fail');
}

describe('each call', () => {
  it.each([
    ['getWabaDetails', getWabaDetails, 'GET', '/111', 'fields=id,name,timezone_id,message_template_namespace,account_review_status'],
    ['getWabaName', getWabaName, 'GET', '/111', 'fields=name'],
    ['getSubscribedApps', getSubscribedApps, 'GET', '/111/subscribed_apps', ''],
    ['getPhoneNumbers', getPhoneNumbers, 'GET', '/111/phone_numbers', ''],
    ['subscribeTokenApp', subscribeTokenApp, 'POST', '/111/subscribed_apps', ''],
    ['unsubscribeTokenApp', unsubscribeTokenApp, 'DELETE', '/111/subscribed_apps', ''],
  ] as const)('%s makes one %s call to %s', async (_name, fn, method, path, query) => {
    const { context, meta } = ctx([json(200, { ok: true })]);
    await fn(context);
    expect(meta.calls).toEqual([{ method, path, query, bearer: true, redirect: 'manual' }]);
  });

  it('debugToken sends the token as the bearer AND as input_token (Meta takes it as a GET parameter), nowhere else', async () => {
    const { context, meta } = ctx([json(200, { data: {} })]);
    await debugToken(context);
    expect(meta.calls).toEqual([{ method: 'GET', path: '/debug_token', query: `input_token=${TOKEN}`, bearer: true, redirect: 'manual' }]);
  });

  it('builds the address from the version and the account id it was given', async () => {
    const seen: string[] = [];
    const fetchSpy = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return json(200, {});
    }) as typeof fetch;
    await getSubscribedApps({ accessToken: TOKEN, wabaId: '999', version: 'v31.2', fetch: fetchSpy });
    expect(seen).toEqual(['https://graph.facebook.com/v31.2/999/subscribed_apps']);
  });

  it('puts no token in any address except debug_token\'s input_token', async () => {
    const seen: string[] = [];
    const fetchSpy = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return json(200, {});
    }) as typeof fetch;
    const context: MetaContext = { accessToken: TOKEN, wabaId: '111', version: 'v26.0', fetch: fetchSpy };
    for (const fn of [getWabaDetails, getWabaName, getSubscribedApps, getPhoneNumbers, subscribeTokenApp, unsubscribeTokenApp]) await fn(context);
    expect(seen.filter((url) => url.includes(TOKEN))).toEqual([]);
  });

  it('returns Meta\'s parsed answer', async () => {
    const { context } = ctx([json(200, { data: [{ id: 'x' }] })]);
    expect(await getSubscribedApps(context)).toEqual({ data: [{ id: 'x' }] });
  });

  it('refuses a redirect instead of sending the token to wherever it points', async () => {
    const { context } = ctx([new Response(null, { status: 302, headers: { Location: 'http://evil.test/' } })]);
    const error = await thrown(getWabaName(context));
    expect(error.status).toBe(302);
  });

  it('gives each call a 20 second limit (an AbortSignal that is not yet aborted)', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchSpy = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      signal = init?.signal;
      return json(200, {});
    }) as typeof fetch;
    await getWabaName({ accessToken: TOKEN, wabaId: '1', version: 'v26.0', fetch: fetchSpy });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});

describe('a failed call', () => {
  it.each([400, 401, 403, 404, 429, 500, 503])('HTTP %i is a MetaCallError with the status and Meta\'s text', async (status) => {
    const { context } = ctx([json(status, { error: { message: 'Meta says no' } })]);
    const error = await thrown(getWabaName(context));
    expect(error.status).toBe(status);
    expect(error.message).toBe(`Meta answered HTTP ${status}`);
    expect(error.detail).toBe('{"error":{"message":"Meta says no"}}');
  });

  it('takes the access token out of Meta\'s reply, wherever it appears', async () => {
    const { context } = ctx([json(400, { error: { message: `bad token ${TOKEN} and again ${TOKEN}` } })]);
    const error = await thrown(getWabaName(context));
    expect(error.detail).not.toContain(TOKEN);
    expect(error.detail).toContain('bad token *** and again ***');
  });

  it('keeps the token out of the error message and the cause it carries for a network fault', async () => {
    const { context } = ctx([new TypeError(`fetch failed ${TOKEN}`)]);
    const error = await thrown(getWabaName(context));
    expect(error.status).toBeUndefined();
    expect(error.message).toBe('Could not reach Meta');
    expect(error.message).not.toContain(TOKEN);
    expect(error.detail).toBeUndefined();
  });

  it('says it timed out, without the token, when the 20 second limit fires', async () => {
    const timeout = Object.assign(new Error(`The operation was aborted due to timeout ${TOKEN}`), { name: 'TimeoutError' });
    const { context } = ctx([timeout]);
    const error = await thrown(getWabaName(context));
    expect(error.message).toBe('No answer from Meta within 20 s');
    expect(error.message).not.toContain(TOKEN);
  });

  it('cuts a very long reply to 2000 characters', async () => {
    const { context } = ctx([new Response('x'.repeat(5000), { status: 500 })]);
    expect((await thrown(getWabaName(context))).detail).toHaveLength(2000);
  });

  it('counts code points, not UTF-16 units, so a cut never splits an emoji', async () => {
    const { context } = ctx([new Response('\u{1F600}'.repeat(2500), { status: 500 })]);
    const detail = (await thrown(getWabaName(context))).detail!;
    expect([...detail]).toHaveLength(2000);
    expect(detail).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('is a MetaCallError for a 200 whose body is not JSON', async () => {
    const { context } = ctx([new Response('<html>', { status: 200 })]);
    const error = await thrown(getWabaName(context));
    expect(error.message).toBe('Meta answered with something that is not JSON');
    expect(error.status).toBe(200);
  });

  it('is a MetaCallError for an empty 200 body', async () => {
    const { context } = ctx([new Response('', { status: 200 })]);
    expect((await thrown(getWabaName(context))).message).toBe('Meta answered with something that is not JSON');
  });

  it('reads a reply whose body fails to arrive as an empty text, still a clean error', async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(`reset ${TOKEN}`));
        },
      }),
      { status: 502 },
    );
    const error = await thrown(getWabaName(ctx([broken]).context));
    expect(error.status).toBe(502);
    expect(error.detail).toBe('');
  });
});

describe('withoutToken', () => {
  it('replaces every occurrence, including adjacent ones', () => {
    expect(withoutToken(`${TOKEN}${TOKEN}-${TOKEN}`, TOKEN)).toBe('******-***');
  });

  it('leaves text alone when the token is empty (an empty split would insert stars between every character)', () => {
    expect(withoutToken('hello', '')).toBe('hello');
  });

  it('does not treat the token as a pattern', () => {
    expect(withoutToken('a.b*c+d', '.*')).toBe('a.b*c+d');
    expect(withoutToken('a.*b', '.*')).toBe('a***b');
  });
});

describe('readSubscribedApps', () => {
  it('reads id, name and the whole entry for each app', () => {
    const apps = readSubscribedApps({ data: [{ whatsapp_business_api_data: { id: '1', name: 'A', link: 'L' } }] });
    expect(apps).toEqual([{ id: '1', name: 'A', fields: { whatsapp_business_api_data: { id: '1', name: 'A', link: 'L' } } }]);
  });

  it('keeps an entry with no whatsapp_business_api_data, with no name and no id, so the count stays right', () => {
    const apps = readSubscribedApps({ data: [{ other: 1 }] });
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: undefined, name: undefined });
  });

  it('names an app "Unknown App" when its data has no name, as Python did, but not when the name is null', () => {
    expect(readSubscribedApps({ data: [{ whatsapp_business_api_data: { id: '1' } }] })[0]!.name).toBe('Unknown App');
    expect(readSubscribedApps({ data: [{ whatsapp_business_api_data: { id: '1', name: null } }] })[0]!.name).toBe('None');
  });

  it('accepts a numeric id, as JSON numbers can arrive, as text', () => {
    expect(readSubscribedApps({ data: [{ whatsapp_business_api_data: { id: 67084, name: 'A' } }] })[0]!.id).toBe('67084');
  });

  it.each([undefined, null, 5, 'x', [], {}, { data: 5 }, { data: 'x' }, { data: null }])('reads %j as no apps', (answer) => {
    expect(readSubscribedApps(answer)).toEqual([]);
  });

  it('copes with entries that are not objects', () => {
    const apps = readSubscribedApps({ data: [null, 5, 'x', [], { whatsapp_business_api_data: 'nope' }] });
    expect(apps).toHaveLength(5);
    expect(apps.every((app) => app.name === undefined && app.id === undefined)).toBe(true);
  });
});

describe('readTokenApp', () => {
  it('reads app_id as id and application as name', () => {
    expect(readTokenApp({ data: { app_id: '1', application: 'A' } })).toEqual({ id: '1', name: 'A' });
  });

  it('accepts a numeric app_id as text', () => {
    expect(readTokenApp({ data: { app_id: 123, application: 'A' } })).toEqual({ id: '123', name: 'A' });
  });

  it('keeps what it can read when one field is missing', () => {
    expect(readTokenApp({ data: { application: 'A' } })).toEqual({ id: undefined, name: 'A' });
    expect(readTokenApp({ data: { app_id: '1' } })).toEqual({ id: '1', name: undefined });
  });

  it.each([undefined, null, 5, 'x', [], {}, { data: null }, { data: 'x' }, { data: [] }])('reads %j as no token info', (answer) => {
    expect(readTokenApp(answer)).toBeUndefined();
  });
});

describe('planUnsubscribe', () => {
  const app = (id: string | undefined, name = 'N'): SubscribedApp => ({ id, name, fields: {} });

  it('says nothing is subscribed for an empty list, whatever the token', () => {
    expect(planUnsubscribe({ id: '1', name: 'A' }, [])).toEqual({ kind: 'nothing_subscribed' });
    expect(planUnsubscribe({ id: undefined, name: undefined }, [])).toEqual({ kind: 'nothing_subscribed' });
  });

  it('is ready when the token\'s app ID is among them, and lists the others', () => {
    const plan = planUnsubscribe({ id: '1', name: 'A' }, [app('2'), app('1'), app('3')]);
    expect(plan.kind).toBe('ready');
    if (plan.kind === 'ready') expect(plan.others.map((other) => other.id)).toEqual(['2', '3']);
  });

  it('refuses when no subscribed app has the token\'s ID', () => {
    expect(planUnsubscribe({ id: '9', name: 'A' }, [app('1'), app('2')]).kind).toBe('token_app_not_subscribed');
  });

  it('refuses when the token\'s ID is unknown, even if a subscribed app also has no ID (undefined must not match undefined)', () => {
    expect(planUnsubscribe({ id: undefined, name: 'A' }, [app(undefined, 'A')]).kind).toBe('token_app_not_subscribed');
  });

  it('matches by ID, not by name', () => {
    expect(planUnsubscribe({ id: '1', name: 'Same' }, [app('2', 'Same')]).kind).toBe('token_app_not_subscribed');
    expect(planUnsubscribe({ id: '1', name: 'Renamed' }, [app('1', 'Original')]).kind).toBe('ready');
  });

  it('matches IDs exactly: no prefix, no number-vs-text confusion', () => {
    expect(planUnsubscribe({ id: '1', name: 'A' }, [app('10')]).kind).toBe('token_app_not_subscribed');
    expect(planUnsubscribe({ id: '10', name: 'A' }, [app('1')]).kind).toBe('token_app_not_subscribed');
    expect(planUnsubscribe({ id: '01', name: 'A' }, [app('1')]).kind).toBe('token_app_not_subscribed');
  });

  it('removes only the first app with that ID from "others" when two entries share it', () => {
    const plan = planUnsubscribe({ id: '1', name: 'A' }, [app('1', 'first'), app('1', 'second')]);
    expect(plan.kind).toBe('ready');
    if (plan.kind === 'ready') expect(plan.others.map((other) => other.name)).toEqual(['second']);
  });

  it('reports the apps it refused over, so the screen can name them', () => {
    const plan = planUnsubscribe({ id: '9', name: 'Mine' }, [app('1', 'One')]);
    expect(plan.kind === 'token_app_not_subscribed' && plan.subscribed.map((a) => a.name)).toEqual(['One']);
  });
});

describe('pythonShow (Python\'s str() of a JSON value)', () => {
  it.each([
    ['text', 'text'],
    [5, '5'],
    [1.5, '1.5'],
    [true, 'True'],
    [false, 'False'],
    [null, 'None'],
    [['a', 1], "['a', 1]"],
    [{ k: 'v' }, "{'k': 'v'}"],
    [{ a: [1, null, true] }, "{'a': [1, None, True]}"],
    [[], '[]'],
    [{}, '{}'],
  ])('%j -> %s', (value, text) => {
    expect(pythonShow(value)).toBe(text);
  });
});

describe('MetaCallError', () => {
  it('carries status and detail, and the original cause', () => {
    const cause = new Error('inner');
    const error = new MetaCallError('m', 400, 'd', { cause });
    expect([error.name, error.status, error.detail, error.cause]).toEqual(['MetaCallError', 400, 'd', cause]);
  });
});
