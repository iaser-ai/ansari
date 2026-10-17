// The apps/auth app over one createAuth(pglite) instance, on an ephemeral
// port, driven with fetch. The database is built from packages/auth's
// migration journal, through that package's own test helpers.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PGlite } from '@electric-sql/pglite';

import type { Auth, Db, EmailMessage, Mailer } from '@ansari/auth';

import {
  drizzleFor,
  migrate,
  setAuthEnv,
} from '../../../../packages/auth/tests/helpers/auth-db';
import type { FailedSignInAlert, ListWalkAlert } from '../../src/alerts';
import { createApp, createServiceAuth } from '../../src/app';

export { TEST_ADMIN_EMAIL } from '../../../../packages/auth/tests/helpers/auth-db';

/** BETTER_AUTH_URL and the one CORS origin in tests. */
export const BASE = 'http://localhost:3100';

export type Service = {
  client: PGlite;
  db: Db;
  auth: Auth;
  publicUrl: string;
  /** Every reset email the service handed to its mailer, in order. */
  mail: EmailMessage[];
  close: () => Promise<void>;
};

export type ServiceOptions = {
  production?: boolean;
  alert?: (alert: ListWalkAlert) => void;
  failedSignInAlert?: (alert: FailedSignInAlert) => void;
  /** Replaces the capturing mailer (which records into `mail`). */
  mailer?: Mailer;
};

function listen(app: { listen: (port: number, cb: () => void) => Server }): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
    // fetch reuses pooled sockets; at Node's 5 s default the server can close
    // an idle one just as the client reuses it (ECONNRESET), and event-loop lag
    // under the full turbo run widens that window. close() still drops idle
    // sockets at once.
    server.keepAliveTimeout = 30_000;
  });
}

const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

export async function startService(options: ServiceOptions = {}): Promise<Service> {
  setAuthEnv(BASE);
  const client = await migrate();
  const db = drizzleFor(client);
  const mail: EmailMessage[] = [];
  const capture: Mailer = async (message) => {
    mail.push(message);
  };
  const auth = createServiceAuth(db, {
    alert: options.alert,
    failedSignInAlert: options.failedSignInAlert,
    mailer: options.mailer ?? capture,
  });
  const appOptions = { production: options.production ?? false };
  const publicServer = await listen(createApp({ auth, db }, appOptions));
  return {
    client,
    db,
    auth,
    publicUrl: urlOf(publicServer),
    mail,
    async close() {
      await new Promise((r) => publicServer.close(r));
      await client.close();
    },
  };
}

let ipCounter = 0;

/** A fresh client IP, so tests not about limits never share a bucket. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  /** X-Real-IP; a fresh one by default, `null` for none. */
  ip?: string | null;
  bearer?: string;
  headers?: Record<string, string>;
};

/** A raw request to a listener. `path` is sent as written (no normalization). */
export async function send(baseUrl: string, path: string, opts: RequestOptions = {}) {
  // Node's fetch sends Sec-Fetch-Mode, so better-auth's CSRF check then
  // requires a trusted Origin, exactly as it would from a browser.
  const headers: Record<string, string> = { origin: BASE, ...opts.headers };
  const ip = opts.ip === undefined ? freshIp() : opts.ip;
  if (ip !== null) headers['x-real-ip'] = ip;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

export async function rateLimitKeys(service: Service): Promise<string[]> {
  const { rows } = await service.client.query<{ key: string }>('select key from auth.rate_limit');
  return rows.map((r) => r.key);
}

export async function rateLimitRow(service: Service, key: string) {
  const { rows } = await service.client.query<{ count: number; last_request: string }>(
    'select count, last_request from auth.rate_limit where key = $1',
    [key]
  );
  return rows[0];
}

export const STRONG_PASSWORD = 'Correct-Horse-Battery-9';

/**
 * The global sign-up ceiling (SIGN_UP_GLOBAL) counts every sign-up in the
 * service, and a suite signs up more users per minute than real traffic does,
 * so this helper clears that one counter first. Tests about the ceiling call
 * the route with `send` instead.
 */
export async function clearSignUpCeiling(service: Service): Promise<void> {
  await service.client.query("delete from auth.rate_limit where key = 'global|/sign-up/email'");
}

export async function signUp(service: Service, email: string, password = STRONG_PASSWORD) {
  await clearSignUpCeiling(service);
  return send(service.publicUrl, '/api/auth/sign-up/email', {
    body: { email, password, name: 'Test User' },
  });
}

export async function signIn(
  service: Service,
  email: string,
  password: string,
  opts: Omit<RequestOptions, 'body'> = {}
) {
  return send(service.publicUrl, '/api/auth/sign-in/email', { ...opts, body: { email, password } });
}

/** The session token and JWT a fresh sign-up returns. */
export async function signUpTokens(service: Service, email: string, password = STRONG_PASSWORD) {
  const res = await signUp(service, email, password);
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  const { token, user } = (await res.json()) as { token: string; user: { id: string } };
  return { id: user.id, sessionToken: token, jwt: await mintJwt(service, token) };
}

/** Exchange a session token for a JWT at /token, as apps/api's layer does. */
export async function mintJwt(service: Service, sessionToken: string): Promise<string> {
  const res = await send(service.publicUrl, '/api/auth/token', { bearer: sessionToken });
  if (res.status !== 200) throw new Error(`token exchange failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/** The status of a session token's JWT exchange at /token (200 while the session lives). */
export async function tokenStatus(service: Service, sessionToken: string): Promise<number> {
  return (await send(service.publicUrl, '/api/auth/token', { bearer: sessionToken })).status;
}
