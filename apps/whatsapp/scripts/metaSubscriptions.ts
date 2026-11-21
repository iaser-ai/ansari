/**
 * The Meta calls and the readers of Meta's answers behind the operator script `checkMetaSubscriptions.ts`.
 *
 * Python counterpart: the functions of `legacy/whatsapp/scripts/check_meta_subscriptions.py` that talk to Meta
 * (`get_waba_details`, `debug_access_token`, `check_subscribed_apps`, `list_phone_numbers`, `subscribe_waba`,
 * `unsubscribe_waba`). Python mixed three jobs in each function: asking Meta, reading the answer, and printing. Here they are
 * split, so the reading and the safety rule can be tested with a fake `fetch` and no keyboard or network, and the printing
 * lives in the script file.
 *
 * A web page called a Messaging account (WABA, WhatsApp Business Account) can be "subscribed" to Meta developer apps; Meta sends
 * a webhook to every subscribed app. This is how an operator checks which apps those are, and changes it.
 * https://developers.facebook.com/docs/whatsapp/embedded-signup/webhooks
 *
 * Differences from Python:
 * - Every call has a 20 second limit. Python's `requests` calls had none, so a stalled connection hung the script.
 * - A failed call is an error value (`MetaCallError`) that carries Meta's status and error text, instead of two printed lines
 *   and a `None`. The caller decides what to print.
 * - The safety check before an unsubscribe compares the token's app ID with the subscribed apps' IDs. Python compared their
 *   NAMES, so two apps with the same name could let the script remove the wrong one. IDs are in both answers.
 * - The access token never leaves the `Authorization` header, except in the one place Meta forces it into a URL (see
 *   `debugToken`), and it is never printed or put in an error. Python printed the token's first 20 and last 10 characters.
 */

import { pythonRepr } from '../src/utils/pythonRepr';

export type FetchLike = typeof fetch;

/** Which Graph API calls the script makes, and where. `version` is `META_API_VERSION`. */
export interface MetaContext {
  accessToken: string;
  /** The Messaging account (WABA) ID, `META_MESSAGING_ACCOUNT_ID`. */
  wabaId: string;
  version: string;
  /** Only tests pass it. */
  fetch?: FetchLike;
}

const GRAPH = 'https://graph.facebook.com';
const TIMEOUT_MS = 20_000;

/** A call to Meta that failed. The message never contains the access token. */
export class MetaCallError extends Error {
  override readonly name = 'MetaCallError';
  /** Meta's HTTP status, or `undefined` for a network fault or a timeout. */
  readonly status: number | undefined;
  /** Meta's reply body, as text, with the access token removed and cut to 2000 characters. */
  readonly detail: string | undefined;

  constructor(message: string, status?: number, detail?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
    this.detail = detail;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replace every occurrence of the token in `text`, so no message can ever echo it. */
export function withoutToken(text: string, accessToken: string): string {
  return accessToken === '' ? text : text.split(accessToken).join('***');
}

async function call(
  context: MetaContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  query: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(`${GRAPH}/${context.version}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const doFetch = context.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method,
      headers: { Authorization: `Bearer ${context.accessToken}` },
      // A redirect would carry the Authorization header to another address
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new MetaCallError(timedOut ? `No answer from Meta within ${TIMEOUT_MS / 1000} s` : 'Could not reach Meta', undefined, undefined, {
      cause: error,
    });
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new MetaCallError(
      `Meta answered HTTP ${response.status}`,
      response.status,
      withoutToken([...text].slice(0, 2000).join(''), context.accessToken),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new MetaCallError('Meta answered with something that is not JSON', response.status, undefined, { cause: error });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Readers: what Meta's answers mean. Pure, so each is tested with a canned answer.
// ---------------------------------------------------------------------------------------------------------------------

/** One app subscribed to the Messaging account (an entry of `data`). */
export interface SubscribedApp {
  id: string | undefined;
  /**
   * The app's name, `Unknown App` when Meta sent the entry without one, and `undefined` when the entry has no
   * `whatsapp_business_api_data` at all (Python listed names only for entries that have it).
   */
  name: string | undefined;
  /** Every field Meta sent for the entry, for the detail screen. */
  fields: Record<string, unknown>;
}

/** Text for a value the way Python's `str()` shows it: a string as it is, anything else as its repr (`True`, `None`, `{'a': 1}`). */
export function pythonShow(value: unknown): string {
  return typeof value === 'string' ? value : pythonRepr(value);
}

/**
 * The apps in a `GET /<WABA>/subscribed_apps` answer. An entry without `whatsapp_business_api_data` is kept (with no name or
 * id) rather than dropped, as Python counted every entry in `data` but only named those with the key.
 */
export function readSubscribedApps(answer: unknown): SubscribedApp[] {
  if (!isRecord(answer) || !Array.isArray(answer.data)) return [];
  return answer.data.map((entry): SubscribedApp => {
    const inner = isRecord(entry) && isRecord(entry.whatsapp_business_api_data) ? entry.whatsapp_business_api_data : undefined;
    const fields = isRecord(entry) ? entry : {};
    return {
      id: typeof inner?.id === 'string' ? inner.id : typeof inner?.id === 'number' ? String(inner.id) : undefined,
      name: inner === undefined ? undefined : Object.hasOwn(inner, 'name') ? pythonShow(inner.name) : 'Unknown App',
      fields,
    };
  });
}

/** The app an access token belongs to, from a `GET /debug_token` answer. */
export interface TokenApp {
  /** Meta's `data.app_id`. */
  id: string | undefined;
  /** Meta's `data.application`, the app's name. */
  name: string | undefined;
}

export function readTokenApp(answer: unknown): TokenApp | undefined {
  if (!isRecord(answer) || !isRecord(answer.data)) return undefined;
  const { app_id: appId, application } = answer.data;
  return {
    id: typeof appId === 'string' ? appId : typeof appId === 'number' ? String(appId) : undefined,
    name: typeof application === 'string' ? application : undefined,
  };
}

/** What `planUnsubscribe` decided. */
export type UnsubscribePlan =
  /** Nothing is subscribed, so there is nothing to remove. */
  | { kind: 'nothing_subscribed' }
  /** The token's app is not among the subscribed ones. The script refuses: the DELETE would remove a different app, or none. */
  | { kind: 'token_app_not_subscribed'; tokenApp: TokenApp; subscribed: SubscribedApp[] }
  /** The token's app is subscribed. This is the only app a DELETE with this token removes. */
  | { kind: 'ready'; tokenApp: TokenApp; others: SubscribedApp[] };

/**
 * Decide whether the unsubscribe may go ahead.
 *
 * `DELETE /<WABA>/subscribed_apps` removes the app the access token belongs to, and no other (the token names the app, the call
 * does not). The script shows the operator what will happen first, and refuses when the token's app is not subscribed, so a
 * mistaken token can never be taken for the one the operator meant.
 *
 * Apps are matched by ID. A name is not unique (two apps can share one), and the ID is in both answers. When the token's ID
 * cannot be read, nothing matches, so the script refuses.
 */
export function planUnsubscribe(tokenApp: TokenApp, subscribed: SubscribedApp[]): UnsubscribePlan {
  if (subscribed.length === 0) return { kind: 'nothing_subscribed' };
  const ours = tokenApp.id === undefined ? undefined : subscribed.find((app) => app.id === tokenApp.id);
  if (!ours) return { kind: 'token_app_not_subscribed', tokenApp, subscribed };
  return { kind: 'ready', tokenApp, others: subscribed.filter((app) => app !== ours) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------------------------------

/** `GET /<WABA>`: its name, time zone and review status. */
export function getWabaDetails(context: MetaContext): Promise<unknown> {
  return call(context, 'GET', context.wabaId, { fields: 'id,name,timezone_id,message_template_namespace,account_review_status' });
}

/** Just the account's name, for the context box and the unsubscribe screen. */
export function getWabaName(context: MetaContext): Promise<unknown> {
  return call(context, 'GET', context.wabaId, { fields: 'name' });
}

/**
 * `GET /debug_token`: which app a token belongs to, what it may do and when it expires.
 *
 * The token that does the asking goes in the header, as everywhere. `input_token`, the token being looked at, is a GET parameter
 * on this endpoint (a POST is refused), so the token does appear in this one URL. That is Meta's design for the endpoint; the
 * URL is never printed or logged here.
 */
export function debugToken(context: MetaContext): Promise<unknown> {
  return call(context, 'GET', 'debug_token', { input_token: context.accessToken });
}

/** `GET /<WABA>/subscribed_apps`. */
export function getSubscribedApps(context: MetaContext): Promise<unknown> {
  return call(context, 'GET', `${context.wabaId}/subscribed_apps`);
}

/** `GET /<WABA>/phone_numbers`. */
export function getPhoneNumbers(context: MetaContext): Promise<unknown> {
  return call(context, 'GET', `${context.wabaId}/phone_numbers`);
}

/** `POST /<WABA>/subscribed_apps`: subscribe the token's app. CHANGES META'S STATE. Only after the operator confirms. */
export function subscribeTokenApp(context: MetaContext): Promise<unknown> {
  return call(context, 'POST', `${context.wabaId}/subscribed_apps`);
}

/** `DELETE /<WABA>/subscribed_apps`: unsubscribe the token's app. CHANGES META'S STATE. Only after `planUnsubscribe` says ready and the operator confirms. */
export function unsubscribeTokenApp(context: MetaContext): Promise<unknown> {
  return call(context, 'DELETE', `${context.wabaId}/subscribed_apps`);
}
