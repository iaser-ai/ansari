// Password reset through apps/auth (spec 300 acceptance, "Password reset";
// plan phase 5): the emailed link has the legacy shape, an unknown email gets
// the identical answer and no mail, a reset kills every session, and the
// strength check runs before the password changes.
import { RESET_EMAIL_FROM, RESET_EMAIL_SUBJECT, resetEmailHtml, resetLink } from '@ansari/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  send,
  signIn,
  signUpTokens,
  startService,
  STRONG_PASSWORD,
  tokenStatus,
  type Service,
} from './helpers/service';

const NEW_PASSWORD = 'Another-Strong-Passphrase-42';
const FRONTEND_URL = 'http://localhost:8081';

let service: Service;
let seq = 0;
const nextEmail = (label: string) => `${label}-${++seq}@example.com`;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  await service.close();
});

const requestReset = (email: string) =>
  send(service.publicUrl, '/api/auth/request-password-reset', { body: { email } });

/** The token in the one reset email sent to `email`. */
function tokenMailedTo(email: string): string {
  const sent = service.mail.filter((m) => m.to === email);
  expect(sent).toHaveLength(1);
  const match = /reset-password\?token=([A-Za-z0-9_-]+)"/.exec(sent[0]?.html ?? '');
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('the reset email', () => {
  it('has the legacy link shape, sender and subject', async () => {
    const email = nextEmail('link');
    await signUpTokens(service, email);
    expect((await requestReset(email)).status).toBe(200);

    const [message] = service.mail.filter((m) => m.to === email);
    const token = tokenMailedTo(email);
    expect(message?.from).toBe(RESET_EMAIL_FROM);
    expect(message?.subject).toBe(RESET_EMAIL_SUBJECT);
    expect(message?.html).toBe(resetEmailHtml(`${FRONTEND_URL}/reset-password?token=${token}`));
    // Never better-auth's own callback URL.
    expect(message?.html).not.toContain('/api/auth/reset-password/');
  });

  it('an unknown email gets the identical response and no mail', async () => {
    const known = nextEmail('known');
    await signUpTokens(service, known);
    const unknown = nextEmail('unknown');
    const before = service.mail.length;

    const a = await requestReset(known);
    const b = await requestReset(unknown);
    expect(b.status).toBe(a.status);
    expect(await b.json()).toEqual(await a.json());
    expect(service.mail.slice(before).map((m) => m.to)).toEqual([known]);
  });

  it('a system address receives no email', async () => {
    const before = service.mail.length;
    expect((await requestReset('ai-skill@system.ansari.chat')).status).toBe(200);
    expect(service.mail.length).toBe(before);
  });

  it('builds the link from FRONTEND_URL with the token encoded, and escapes it in the HTML', () => {
    expect(resetLink('https://askansari.ai/', 'a b&c')).toBe(
      'https://askansari.ai/reset-password?token=a%20b%26c'
    );
    const html = resetEmailHtml('https://x.example/reset-password?token=a"><script>');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('consuming the reset token', () => {
  it('a weak new password is refused and the token still works for a strong one', async () => {
    const email = nextEmail('weak');
    await signUpTokens(service, email);
    await requestReset(email);
    const token = tokenMailedTo(email);

    const weak = await send(service.publicUrl, '/api/auth/reset-password', {
      body: { token, newPassword: 'password1' },
    });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { code: string }).code).toBe('PASSWORD_TOO_WEAK');

    const strong = await send(service.publicUrl, '/api/auth/reset-password', {
      body: { token, newPassword: NEW_PASSWORD },
    });
    expect(strong.status).toBe(200);
  });

  it('a reset kills every session and only the new password signs in', async () => {
    const email = nextEmail('kill');
    const { sessionToken } = await signUpTokens(service, email);
    const second = (
      (await (await signIn(service, email, STRONG_PASSWORD)).json()) as { token: string }
    ).token;
    await requestReset(email);
    const token = tokenMailedTo(email);

    const res = await send(service.publicUrl, '/api/auth/reset-password', {
      body: { token, newPassword: NEW_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(await tokenStatus(service, sessionToken)).toBe(401);
    expect(await tokenStatus(service, second)).toBe(401);
    expect((await signIn(service, email, STRONG_PASSWORD)).status).toBe(401);
    expect((await signIn(service, email, NEW_PASSWORD)).status).toBe(200);

    // The token is single-use.
    const again = await send(service.publicUrl, '/api/auth/reset-password', {
      body: { token, newPassword: 'Yet-Another-Passphrase-77' },
    });
    expect(again.status).toBe(400);
  });
});

describe('a failing mailer', () => {
  it('does not change the response, and logs the error name only', async () => {
    const failing = await startService({
      mailer: async () => {
        throw new TypeError('network down for re_test_key_at_least_20_chars');
      },
    });
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const email = nextEmail('failing');
      const res = await send(failing.publicUrl, '/api/auth/sign-up/email', {
        body: { email, password: STRONG_PASSWORD, name: 'X' },
      });
      expect(res.status).toBe(200);
      const reset = await send(failing.publicUrl, '/api/auth/request-password-reset', {
        body: { email },
      });
      expect(reset.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(errors).toContainEqual(['Password reset email failed:', 'TypeError']);
      expect(JSON.stringify(errors)).not.toContain('re_test_key');
      expect(JSON.stringify(errors)).not.toContain(email);
    } finally {
      console.error = original;
      await failing.close();
    }
  });
});
