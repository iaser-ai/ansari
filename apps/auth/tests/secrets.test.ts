// RESEND_API_KEY and BETTER_AUTH_SECRET appear in no log line and no response
// body, and a user's JWT and session token appear in no log line (spec 300
// acceptance, "Password reset"; plan phase 5; owner amendment 2026-10-17).
// Every console call and every stdout/stderr write is captured while the
// service is driven through its success, refusal and failure paths, and every
// response body is kept; then each value is searched for in all of it.
import { getEnv, resetEnvCache } from '@ansari/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setAuthEnv } from '../../../packages/auth/tests/helpers/auth-db';
import {
  BASE,
  send,
  signUpTokens,
  startService,
  STRONG_PASSWORD,
  type Service,
} from './helpers/service';

const RESEND_KEY = 're_test_key_at_least_20_chars';
const AUTH_SECRET = 'test-secret-at-least-32-characters-long-000';

const captured: string[] = [];
const bodies: string[] = [];
const restore: (() => void)[] = [];

function capture(): void {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      captured.push(
        args
          .map((a) =>
            a instanceof Error
              ? `${a.name} ${a.message} ${a.stack}`
              : (JSON.stringify(a) ?? String(a))
          )
          .join(' ')
      );
    };
    restore.push(() => {
      console[method] = original;
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => {
      stream.write = original;
    });
  }
}

async function keep(res: Promise<Response>): Promise<Response> {
  const response = await res;
  bodies.push(await response.clone().text());
  bodies.push(JSON.stringify([...response.headers.entries()]));
  return response;
}

let service: Service;
let failingMail: Service;

beforeAll(async () => {
  service = await startService();
  failingMail = await startService({
    mailer: async () => {
      throw new Error(`Resend refused: bad key ${RESEND_KEY} / ${AUTH_SECRET}`);
    },
  });
  capture();
});

afterAll(async () => {
  for (const undo of restore.reverse()) undo();
  await service.close();
  await failingMail.close();
});

describe('secrets in logs and bodies', () => {
  it('the test secrets are the ones the service runs with', () => {
    expect(getEnv().BETTER_AUTH_SECRET).toBe(AUTH_SECRET);
    expect(getEnv().RESEND_API_KEY).toBe(RESEND_KEY);
  });

  it("appear nowhere across the service's paths", async () => {
    const email = 'secrets@example.com';
    const user = await signUpTokens(service, email);
    const account = (base: string, path: string, method = 'GET', bearer?: string) =>
      keep(send(base, `/api/account${path}`, { method, bearer }));

    // The account endpoints: no token, a bad one, the session token, the real JWT.
    await account(service.publicUrl, '/me');
    await account(service.publicUrl, '/me', 'GET', 'not.a.jwt');
    await account(service.publicUrl, '/me', 'GET', user.sessionToken);
    await account(service.publicUrl, '/me', 'GET', user.jwt);
    await account(service.publicUrl, '', 'DELETE', 'not.a.jwt');
    await account(service.publicUrl, '/revoke-sessions', 'POST', user.sessionToken);
    await keep(send(service.publicUrl, '/api/auth/jwks'));
    await keep(send(service.publicUrl, '/nowhere'));
    // The removed hop's headers are ignored.
    await keep(
      send(service.publicUrl, `/internal/users/${user.id}/profile`, {
        headers: { 'x-ansari-internal-auth': AUTH_SECRET },
      })
    );

    // Reset: known, unknown, a bad token; a mailer that fails with both secrets in its error.
    await keep(send(service.publicUrl, '/api/auth/request-password-reset', { body: { email } }));
    await keep(
      send(service.publicUrl, '/api/auth/request-password-reset', {
        body: { email: 'nobody@example.com' },
      })
    );
    await keep(
      send(service.publicUrl, '/api/auth/reset-password', {
        body: { token: 'bad', newPassword: STRONG_PASSWORD },
      })
    );
    await keep(
      send(failingMail.publicUrl, '/api/auth/sign-up/email', {
        body: { email, password: STRONG_PASSWORD, name: 'X' },
      })
    );
    await keep(
      send(failingMail.publicUrl, '/api/auth/request-password-reset', { body: { email } })
    );
    await new Promise((r) => setTimeout(r, 50));

    // The account endpoints with a dead database (the 500 path), then the subject's own delete.
    const dead = await startService();
    const deadUser = await signUpTokens(dead, 'dead-db@example.com');
    await dead.client.close();
    await account(dead.publicUrl, '/me', 'GET', deadUser.jwt);
    await account(dead.publicUrl, '', 'DELETE', deadUser.jwt);
    await dead.close().catch(() => undefined);
    await account(service.publicUrl, '', 'DELETE', user.jwt);

    // Env validation with both secrets too short: the error names variables only.
    process.env.BETTER_AUTH_SECRET = 'short-better-auth-secret';
    process.env.RESEND_API_KEY = 're_short_key';
    resetEnvCache();
    let envError = '';
    try {
      getEnv();
    } catch (err) {
      envError = err instanceof Error ? err.message : String(err);
    }
    captured.push(envError);
    expect(envError).toContain('BETTER_AUTH_SECRET');
    expect(envError).not.toContain('short-better-auth-secret');
    expect(envError).not.toContain('re_short_key');
    setAuthEnv(BASE);

    // The capture saw the failure paths, so an empty search proves something.
    const logs = captured.join('\n');
    expect(logs).toContain('Password reset email failed:');
    expect(logs).toContain('account me failed:');
    expect(logs).toContain('account delete failed:');
    expect(bodies.length).toBeGreaterThan(30);

    for (const secret of [AUTH_SECRET, RESEND_KEY]) {
      expect(logs.includes(secret), `log carries ${secret.slice(0, 8)}…`).toBe(false);
      expect(
        bodies.some((b) => b.includes(secret)),
        `a body carries ${secret.slice(0, 8)}…`
      ).toBe(false);
    }
    for (const token of [user.jwt, user.sessionToken, deadUser.jwt]) {
      expect(logs.includes(token), `log carries a token ${token.slice(0, 8)}…`).toBe(false);
    }
    expect(logs.includes(email)).toBe(false);
  });
});
