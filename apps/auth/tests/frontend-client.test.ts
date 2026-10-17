// Contract pins for apps/frontend's apps/auth client (plan phase 10; app
// architect's condition). The client is hand-rolled over customFetch, so it
// depends on better-auth's response shapes: the session token in the sign-in
// and sign-up bodies, the /token body, sign-out's body, and the status codes
// that separate a refused credential (401) from a rate limit (429). This suite
// runs the frontend's OWN module (apps/frontend/lib/auth/api.ts, imported by
// path) against a real apps/auth, so a better-auth bump that changes a shape
// goes red here, not in production.
//
// Two transports, both bearer-only:
// - native: a fetch over node:http that sends exactly the client's headers —
//   no Origin, no Cookie, no Sec-Fetch-* (React Native's fetch sends none);
// - web: Node's fetch plus the Origin a browser adds, from the allowed web
//   origin (Node's fetch also sends Sec-Fetch-Mode, so better-auth's CSRF
//   check runs, exactly as for a browser).
// Each request carries a fresh X-Real-IP, as Railway's edge sets one.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INVALID_RESET_TOKEN_MESSAGE } from '@ansari/auth';

import {
  AuthError,
  createAuthApi,
  INVALID_RESET_TOKEN_MESSAGE as CLIENT_INVALID_RESET_TOKEN_MESSAGE,
  type AuthApi,
} from '../../frontend/lib/auth/api';
import { CLIENT_IDS } from '../../frontend/lib/auth/client-id-values';
import { generateGuestCredentials } from '../../frontend/lib/auth/guest';
import { BASE, freshIp, startService, type Service } from './helpers/service';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;

function headerRecord(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** React Native's fetch, as far as the server can tell: only the given headers. */
const nativeFetch: FetchLike = (input, init) =>
  new Promise((resolve, reject) => {
    const url = new URL(input);
    const headers = { ...headerRecord(init), 'x-real-ip': freshIp() };
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: init.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(key, String(value));
          }
          const status = res.statusCode ?? 0;
          const body = [204, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers: responseHeaders }));
        });
      }
    );
    req.on('error', reject);
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });

/** A browser on the allowed web origin. */
const webFetch: FetchLike = (input, init) => {
  const headers = { ...headerRecord(init), origin: BASE, 'x-real-ip': freshIp() };
  return realFetch(input, { ...init, headers });
};

/** Every request the client made, as the transport saw it. */
const seen: { url: string; init: RequestInit }[] = [];

function using(transport: FetchLike): void {
  globalThis.fetch = ((input: string, init: RequestInit) => {
    seen.push({ url: String(input), init });
    return transport(input, init);
  }) as typeof fetch;
}

let service: Service;

beforeAll(async () => {
  // Sign-in failures count per email (5/60 s), as in production.
  service = await startService();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await service?.close();
});

function client(clientId: string): AuthApi {
  return createAuthApi({ baseUrl: service.publicUrl, clientId });
}

async function registeredVia(email: string): Promise<string | null | undefined> {
  const { rows } = await service.client.query<{ registered_via: string | null }>(
    'select registered_via from auth.users where email = $1',
    [email]
  );
  return rows[0]?.registered_via;
}

async function failure(call: () => Promise<unknown>): Promise<AuthError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('expected the call to fail');
}

describe.each([
  ['native', nativeFetch, CLIENT_IDS.ios],
  ['web', webFetch, CLIENT_IDS.web],
] as const)('the frontend client over the %s transport', (label, transport, clientId) => {
  const api = () => client(clientId);
  const email = `frontend-${label}@example.com`;
  const password = 'Frontend-pass-123!';

  beforeAll(() => using(transport));

  it('sign-up answers with a session token and the names; X-Ansari-Client is recorded', async () => {
    const session = await api().signUp({
      email,
      password,
      firstName: 'Amina',
      lastName: 'Yusuf',
      registerToMailList: true,
    });
    expect(session.sessionToken).toMatch(/\S{20,}/);
    expect([session.firstName, session.lastName]).toEqual(['Amina', 'Yusuf']);
    expect(await registeredVia(email)).toBe(clientId);
  });

  it('sign-in answers with a session token and the stored names', async () => {
    const session = await api().signIn(email, password);
    expect(session.sessionToken).toMatch(/\S{20,}/);
    expect([session.firstName, session.lastName]).toEqual(['Amina', 'Yusuf']);
  });

  it('/token mints a JWT for the session: three segments, sub = the user id', async () => {
    const { sessionToken } = await api().signIn(email, password);
    const jwt = await api().mintJwt(sessionToken);
    const segments = jwt.split('.');
    expect(segments).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(segments[1] as string, 'base64url').toString()) as {
      sub: string;
    };
    const { rows } = await service.client.query<{ id: string }>(
      'select id from auth.users where email = $1',
      [email]
    );
    expect(payload.sub).toBe(rows[0]?.id);
  });

  it('a wrong password is 401 from sign-in (the one failure that replaces a guest)', async () => {
    const error = await failure(() => api().signIn(email, 'Wrong-pass-123!'));
    expect([error.status, error.endpoint]).toEqual([401, 'sign-in']);
  });

  it('an unknown account is 401 from sign-in too', async () => {
    const error = await failure(() => api().signIn(`nobody-${label}@example.com`, password));
    expect([error.status, error.endpoint]).toEqual([401, 'sign-in']);
  });

  it('a taken email is 409 from sign-up, with the legacy message', async () => {
    const error = await failure(() => api().signUp({ email, password }));
    expect([error.status, error.endpoint, error.message]).toEqual([
      409,
      'sign-up',
      'An account with this email already exists',
    ]);
  });

  it('sign-out ends the session: /token then answers 401', async () => {
    const { sessionToken } = await api().signIn(email, password);
    await api().signOut(sessionToken);
    const error = await failure(() => api().mintJwt(sessionToken));
    expect([error.status, error.endpoint]).toEqual([401, 'token']);
  });

  it('a generated guest signs up, then signs back in with the stored credentials', async () => {
    const guest = generateGuestCredentials();
    const first = await api().signUp(guest);
    expect([first.firstName, first.lastName]).toEqual(['Welcome', 'Guest']);
    const again = await api().signIn(guest.email, guest.password);
    expect(again.sessionToken).not.toBe(first.sessionToken);
  });

  it('sign-in failures past the limit are 429, never 401 (a guest is never replaced)', async () => {
    const locked = `locked-${label}@example.com`;
    await api().signUp({ email: locked, password });
    for (let i = 0; i < 5; i++) {
      expect((await failure(() => api().signIn(locked, 'Wrong-pass-123!'))).status).toBe(401);
    }
    const error = await failure(() => api().signIn(locked, password));
    expect([error.status, error.endpoint]).toEqual([429, 'sign-in']);
  });

  it('no request carried a cookie or asked for one', () => {
    expect(seen.length).toBeGreaterThan(0);
    for (const { init } of seen) {
      expect(init.credentials).toBe('omit');
      expect(new Headers(init.headers).has('cookie')).toBe(false);
    }
  });
});

describe.each([
  ['native', nativeFetch, CLIENT_IDS.ios],
  ['web', webFetch, CLIENT_IDS.web],
] as const)('password reset through the frontend client over the %s transport (#304)', (label, transport, clientId) => {
  const api = () => client(clientId);
  const email = `reset-${label}@example.com`;
  const password = 'Before-reset-123!';
  const newPassword = 'After-reset-456!';

  beforeAll(async () => {
    using(transport);
    await api().signUp({ email, password });
  });

  const mailTo = (to: string) => service.mail.filter((m) => m.to === to);

  /**
   * Requests a reset and returns the token from the email THIS request sent,
   * as the link carries it. The mail count is taken before the request, so
   * an earlier message to the same address can never satisfy the wait.
   */
  async function requestToken(to: string): Promise<string> {
    const before = mailTo(to).length;
    await api().requestPasswordReset(to);
    // The send is fire-and-forget on the server; wait for it to land.
    for (let i = 0; i < 50; i++) {
      const message = mailTo(to)[before];
      const match = message?.html.match(/\/reset-password\?token=([^"&<\s]+)/);
      if (match) return decodeURIComponent(match[1] as string);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no new reset email');
  }

  it('a request answers the same for a known and an unknown email; only the known one gets mail', async () => {
    const unknown = `nobody-${label}@example.com`;
    await expect(api().requestPasswordReset(unknown)).resolves.toBeUndefined();
    expect(await requestToken(email)).toMatch(/\S{10,}/);
    expect(mailTo(unknown)).toHaveLength(0);
  });

  it('a weak new password is refused with the server message, and the token survives', async () => {
    const token = await requestToken(email);
    const error = await failure(() => api().resetPassword(token, 'weakweak'));
    expect([error.status, error.endpoint]).toEqual([400, 'reset-password']);
    expect(error.message).toMatch(/\S/);
    await expect(api().resetPassword(token, newPassword)).resolves.toBeUndefined();
  });

  it('the new password signs in, the old one does not, and the token is single-use', async () => {
    const session = await api().signIn(email, newPassword);
    expect(session.sessionToken).toMatch(/\S{20,}/);
    expect((await failure(() => api().signIn(email, password))).status).toBe(401);

    const token = await requestToken(email);
    await api().resetPassword(token, 'Third-pass-789!');
    const reused = await failure(() => api().resetPassword(token, 'Fourth-pass-012!'));
    expect([reused.status, reused.endpoint, reused.message]).toEqual([
      400,
      'reset-password',
      INVALID_RESET_TOKEN_MESSAGE,
    ]);
    // Reset ended every session, the one signed in above included.
    expect((await failure(() => api().mintJwt(session.sessionToken))).status).toBe(401);
  });

  it('an invented token is the same 400', async () => {
    const error = await failure(() => api().resetPassword('not-a-real-token', newPassword));
    expect([error.status, error.message]).toEqual([400, INVALID_RESET_TOKEN_MESSAGE]);
  });

  it("the client's copy of the invalid-token message is apps/auth's (the reset page keys on it)", () => {
    expect(CLIENT_INVALID_RESET_TOKEN_MESSAGE).toBe(INVALID_RESET_TOKEN_MESSAGE);
  });
});

describe('the web transport, as the browser enforces it', () => {
  it('apps/auth lets the web origin read the response (CORS allow-origin, no credentials)', async () => {
    const res = await realFetch(`${service.publicUrl}/api/auth/token`, {
      headers: { origin: BASE, 'x-real-ip': freshIp() },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(BASE);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('the preflight allows every header the client sends', async () => {
    const res = await realFetch(`${service.publicUrl}/api/auth/sign-in/email`, {
      method: 'OPTIONS',
      headers: {
        origin: BASE,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-ansari-client',
        'x-real-ip': freshIp(),
      },
    });
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['authorization', 'content-type', 'x-ansari-client']) {
      expect(allowed).toContain(header);
    }
  });
});

describe('X-Ansari-Client: the client ids and apps/auth agree', () => {
  it.each(Object.values(CLIENT_IDS))('%s is stored verbatim as registered_via', async (id) => {
    using(webFetch);
    const email = `via-client-${id}@example.com`;
    await client(id).signUp({ email, password: 'Frontend-pass-123!' });
    expect(await registeredVia(email)).toBe(id);
  });
});

describe('the cache sees every client file this suite runs', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const ENTRIES = ['lib/auth/api.ts', 'lib/auth/client-id-values.ts', 'lib/auth/guest.ts'].map(
    (file) => resolve(root, 'apps/frontend', file)
  );

  /** Relative imports, followed transitively (bare specifiers are packages). */
  function importGraph(entries: string[]): string[] {
    const found = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (found.has(file)) continue;
      found.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/gm)) {
        queue.push(resolve(dirname(file), `${match[1]}.ts`));
      }
      // An `@/` import would not resolve in this suite at all, and would hide
      // a file from the graph: refuse it.
      expect(source, relative(root, file)).not.toMatch(/from\s+['"]@\//);
    }
    return [...found].map((file) => relative(root, file));
  }

  it('the import graph is covered by apps/auth/turbo.json test inputs', () => {
    const turbo = readFileSync(resolve(root, 'apps/auth/turbo.json'), 'utf8');
    const inputs = [...turbo.matchAll(/"\$TURBO_ROOT\$\/([^"]+)"/g)].map((m) => m[1] as string);
    const covered = (file: string) =>
      inputs.some((input) =>
        input.endsWith('/**') ? file.startsWith(input.slice(0, -2)) : file === input
      );
    const graph = importGraph(ENTRIES);
    expect(graph).toContain('apps/frontend/vendor/api-client-react/custom-fetch.ts');
    expect(graph.filter((file) => !covered(file))).toEqual([]);
  });
});
