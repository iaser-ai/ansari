// The reset sender createAuth() installs (spec 300, "Password reset"). The
// HTTP flow is proven in apps/auth/tests/reset.test.ts; this pins the sender's
// own refusals and its non-blocking send.
import { describe, expect, it } from 'vitest';

import {
  createResetPasswordSender,
  RESET_EMAIL_FROM,
  RESET_EMAIL_SUBJECT,
  resetEmailHtml,
  resetLink,
  type EmailMessage,
} from '../../src/reset-email';

const FRONTEND = 'https://askansari.ai';

describe('createResetPasswordSender', () => {
  it('sends the legacy link to the user, from the legacy sender', async () => {
    const sent: EmailMessage[] = [];
    const send = createResetPasswordSender(FRONTEND, async (m) => {
      sent.push(m);
    });
    await send({ user: { email: 'user@example.com' }, token: 'tok123' });
    expect(sent).toEqual([
      {
        from: RESET_EMAIL_FROM,
        to: 'user@example.com',
        subject: RESET_EMAIL_SUBJECT,
        html: resetEmailHtml('https://askansari.ai/reset-password?token=tok123'),
      },
    ]);
    expect(RESET_EMAIL_FROM).toBe('Ansari <feedback@askansari.ai>');
  });

  it('refuses the system domain, in any case', async () => {
    const sent: EmailMessage[] = [];
    const send = createResetPasswordSender(FRONTEND, async (m) => {
      sent.push(m);
    });
    await send({ user: { email: 'ai-skill@system.ansari.chat' }, token: 't' });
    await send({ user: { email: ' Leaderboard@SYSTEM.Ansari.Chat ' }, token: 't' });
    expect(sent).toHaveLength(0);
  });

  it('does not wait for delivery, so a known email answers as fast as an unknown one', async () => {
    const send = createResetPasswordSender(FRONTEND, () => new Promise<void>(() => undefined));
    const result = await Promise.race([
      send({ user: { email: 'slow@example.com' }, token: 't' }).then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('blocked'), 50)),
    ]);
    expect(result).toBe('returned');
  });

  it('a trailing slash on FRONTEND_URL does not double the slash', () => {
    expect(resetLink('https://askansari.ai/', 'x')).toBe(
      'https://askansari.ai/reset-password?token=x'
    );
  });
});
