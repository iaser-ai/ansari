// The admin plugin's HTTP surface, change-email, update-user and change-password never answer
// (spec 300; scenario 28). The admin endpoints are
// enumerated from the installed package, so a better-auth upgrade that adds one
// is covered without editing this file. Every request carries a VALID admin
// session, so a pass cannot come from a missing or non-admin session.
import { request } from 'node:http';

import { BLOCKED_AUTH_PATHS } from '@ansari/auth';
import { admin } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalPath, isBlockedPath } from '../src/middleware/blocked-paths';
import {
  send,
  signIn,
  signUp,
  startService,
  STRONG_PASSWORD,
  type Service,
} from './helpers/service';

let service: Service;
let adminToken: string;

const ADMIN_USER = 'operator@example.com';

beforeAll(async () => {
  service = await startService();
  expect((await signUp(service, ADMIN_USER)).status).toBe(200);
  await service.client.query(`update auth.users set role = 'admin' where email = $1`, [ADMIN_USER]);
  const res = await signIn(service, ADMIN_USER, STRONG_PASSWORD);
  expect(res.status).toBe(200);
  adminToken = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await service?.close();
});

type ApiEndpoint = { path?: string; options?: { method?: string | string[] } };

/** The admin plugin's endpoints, walked from the running instance's `auth.api`. */
function adminEndpoints(): { path: string; method: string }[] {
  return Object.values(service.auth.api as unknown as Record<string, ApiEndpoint>)
    .filter((e) => typeof e.path === 'string' && e.path.startsWith('/admin/'))
    .map((e) => {
      const method = e.options?.method;
      return { path: e.path as string, method: (Array.isArray(method) ? method[0] : method) ?? 'POST' };
    });
}

/** The variants a router could still map to the same endpoint. */
function variants(path: string): string[] {
  const full = `/api/auth${path}`;
  const [, first = '', ...rest] = path.split('/');
  const encodedFirst = `%${first.charCodeAt(0).toString(16)}${first.slice(1)}`;
  return [
    full,
    full.toUpperCase(),
    `/api/auth/${first.toUpperCase()}/${rest.join('/')}`.replace(/\/$/, ''),
    `${full}/`,
    `${full}//`,
    `/api/auth/${encodedFirst}${rest.length ? `/${rest.join('/')}` : ''}`,
    `/api/auth/${encodedFirst.replace('%', '%25')}${rest.length ? `/${rest.join('/')}` : ''}`,
    `/api/auth//${path.slice(1)}`,
    `/api/auth/./${path.slice(1)}`,
    `/api/auth/x/..${path}`,
    `/api/auth\\${path.slice(1)}`,
    `${full}?x=1`,
  ];
}

async function expectBlocked(baseUrl: string, path: string, method: string, headers = {}) {
  const res = await send(baseUrl, path, {
    method,
    bearer: adminToken,
    headers,
    body: method === 'GET' ? undefined : {},
  });
  expect({ path, status: res.status, body: await res.text() }).toEqual({ path, status: 404, body: '' });
}

describe('the admin session is real', () => {
  it('the admin token is accepted by the admin plugin in process', async () => {
    const res = await service.auth.api.listUsers({
      headers: new Headers({ authorization: `Bearer ${adminToken}` }),
      query: {},
      asResponse: true,
    });
    expect(res.status).toBe(200);
  });
});

describe('the admin surface, from the installed package', () => {
  it('enumerates the same endpoints as the admin plugin, impersonation included', () => {
    const fromApi = adminEndpoints().map((e) => e.path).sort();
    const fromPlugin = Object.values(admin().endpoints).map((e) => e.path).sort();
    expect(fromApi).toEqual(fromPlugin);
    expect(fromApi).toContain('/admin/impersonate-user');
    expect(fromApi).toContain('/admin/set-role');
    expect(fromApi.length).toBeGreaterThanOrEqual(14);
    expect(BLOCKED_AUTH_PATHS).toEqual(expect.arrayContaining(fromApi));
  });

  it('every admin endpoint and each of its variants gets the block response', async () => {
    for (const { path, method } of adminEndpoints()) {
      for (const variant of variants(path)) await expectBlocked(service.publicUrl, variant, method);
    }
  });
});

describe('change-email, update-user and change-password', () => {
  it.each(['/change-email', '/update-user', '/change-password'])('%s and its variants get the block response', async (path) => {
    for (const variant of variants(path)) {
      await expectBlocked(service.publicUrl, variant, 'POST');
    }
  });

  it('the profile is unchanged', async () => {
    await send(service.publicUrl, '/api/auth/update-user', {
      bearer: adminToken,
      body: { name: 'Changed' },
    });
    const { rows } = await service.client.query<{ name: string }>(
      'select name from auth.users where email = $1',
      [ADMIN_USER]
    );
    expect(rows[0]?.name).toBe('Test User');
  });

  // Better Auth's change-password checks only the length and, by default,
  // keeps the other sessions alive; it must not answer at all.
  it('the password is unchanged, and the other sessions live on', async () => {
    const res = await send(service.publicUrl, '/api/auth/change-password', {
      bearer: adminToken,
      body: { currentPassword: STRONG_PASSWORD, newPassword: 'aaaaaaaa', revokeOtherSessions: false },
    });
    expect(res.status).not.toBe(200);
    expect((await signIn(service, ADMIN_USER, 'aaaaaaaa')).status).toBe(401);
    expect((await signIn(service, ADMIN_USER, STRONG_PASSWORD)).status).toBe(200);
    expect((await send(service.publicUrl, '/api/auth/get-session', { bearer: adminToken })).status).toBe(200);
  });
});

describe('near misses still reach Better Auth', () => {
  it('get-session answers for the admin session', async () => {
    const res = await send(service.publicUrl, '/api/auth/get-session', { bearer: adminToken });
    expect(res.status).toBe(200);
  });

  it('a path that only starts with "admin" is not blocked', () => {
    expect(isBlockedPath('/api/auth/administrator')).toBe(false);
    expect(isBlockedPath('/api/auth/update-user-x')).toBe(false);
    expect(isBlockedPath('/api/auth/change-password-x')).toBe(false);
    expect(isBlockedPath('/api/auth/sign-in/email')).toBe(false);
  });
});

describe('canonicalPath', () => {
  it.each([
    ['/api/auth/ADMIN/Set-Role/', '/api/auth/admin/set-role'],
    ['/api/auth/%61dmin/set-role', '/api/auth/admin/set-role'],
    ['/api/auth/%2561dmin/set-role', '/api/auth/admin/set-role'],
    ['/api/auth//admin///set-role', '/api/auth/admin/set-role'],
    ['/api/auth/x/../admin/./set-role', '/api/auth/admin/set-role'],
    ['/api/auth\\admin\\set-role', '/api/auth/admin/set-role'],
    ['/api/auth/admin%2Fset-role?y=1#z', '/api/auth/admin/set-role'],
    ['http://auth.example/api/auth/admin/set-role', '/api/auth/admin/set-role'],
    ['HTTPS://auth.example:3100/api/auth/Change-Password/', '/api/auth/change-password'],
    ['/', '/'],
  ])('%s → %s', (raw, expected) => {
    expect(canonicalPath(raw)).toBe(expected);
  });

  // A request line may carry an absolute-form target (RFC 9112 3.2.2), which
  // Node passes through as req.url. Sent raw, on the wire.
  it('an absolute-form request target gets the block response', async () => {
    for (const base of [service.publicUrl]) {
      const { port } = new URL(base);
      for (const target of [
        `http://localhost:${port}/api/auth/admin/list-users`,
        `http://localhost:${port}/api/auth/change-password`,
      ]) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: Number(port),
              method: 'POST',
              path: target,
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${adminToken}`,
              },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            }
          );
          req.on('error', reject);
          req.end('{}');
        });
        expect({ base, target, status }).toEqual({ base, target, status: 404 });
      }
    }
  });

  it('malformed percent-encoding is refused', () => {
    expect(canonicalPath('/api/auth/%E0%A4%A')).toBeNull();
    expect(isBlockedPath('/api/auth/%E0%A4%A')).toBe(true);
  });
});
