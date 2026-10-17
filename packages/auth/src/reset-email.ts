// The password-reset email (spec 300). After the cutover apps/auth sends it,
// with the link, sender and wording apps/api sends today (lib/email.ts and
// emails/password-reset.tsx), so a link in an inbox keeps working across the
// cutover and the frontend's /reset-password page reads the same `?token=`.
//
// Nothing here logs the address, the link, the token or the Resend key.
import { Resend } from 'resend';

import { isSystemAddress } from './reserved';

/** The same sender as apps/api/lib/email.ts. */
export const RESET_EMAIL_FROM = 'Ansari <feedback@askansari.ai>';
export const RESET_EMAIL_SUBJECT = 'Ansari Password Reset';

export type EmailMessage = { from: string; to: string; subject: string; html: string };

/** Delivers one message; rejects on failure. Injectable so tests capture mail. */
export type Mailer = (message: EmailMessage) => Promise<void>;

/** The legacy link shape: `${FRONTEND_URL}/reset-password?token=<token>`. */
export function resetLink(frontendUrl: string, token: string): string {
  return `${frontendUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The legacy template's content, as static HTML (no React renderer in this service). */
export function resetEmailHtml(resetUrl: string): string {
  const url = escapeHtml(resetUrl);
  const text = (body: string) =>
    `<p style="font-size:14px;line-height:24px;margin:16px 0">${body}</p>`;
  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta content="text/html; charset=UTF-8" http-equiv="Content-Type"/></head>',
    '<body style="font-family:Arial, sans-serif;background-color:#f6f6f6;padding:20px">',
    '<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">',
    'Reset your Ansari password</div>',
    '<table align="center" width="100%" role="presentation" cellspacing="0" cellpadding="0" border="0"',
    ' style="max-width:600px;background-color:#ffffff;padding:30px;border-radius:5px"><tbody><tr><td>',
    '<h2>Reset your Ansari Password</h2>',
    text('Click the link below to reset your password for Ansari.'),
    text('If you did not request a reset of your Ansari password, you can safely ignore this.'),
    text(
      `Click on <a href="${url}" style="color:#067df7;text-decoration:none">this link</a> to reset your password.`
    ),
    text('Or paste this link into your browser:'),
    text(url),
    '</td></tr></tbody></table></body></html>',
  ].join('');
}

/** Resend, keyed by RESEND_API_KEY. A Resend error rejects with its name only. */
export function resendMailer(apiKey: string): Mailer {
  const resend = new Resend(apiKey);
  return async (message) => {
    const { error } = await resend.emails.send(message);
    if (error) throw new Error(`Resend refused the message (${error.name})`);
  };
}

/**
 * better-auth's `sendResetPassword`. A system address never receives mail: it
 * has no auth row, so better-auth never calls this for one, and the domain is
 * refused here as well. The send is not awaited, as in apps/api today, so a
 * known email answers as fast as an unknown one; a failure logs its error name.
 */
export function createResetPasswordSender(frontendUrl: string, mailer: Mailer) {
  return async ({ user, token }: { user: { email: string }; token: string }): Promise<void> => {
    if (isSystemAddress(user.email)) return;
    const html = resetEmailHtml(resetLink(frontendUrl, token));
    void mailer({
      from: RESET_EMAIL_FROM,
      to: user.email,
      subject: RESET_EMAIL_SUBJECT,
      html,
    }).catch((err: unknown) => {
      console.error('Password reset email failed:', err instanceof Error ? err.name : 'unknown');
    });
  };
}
