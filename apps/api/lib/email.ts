import { Resend } from 'resend';
import { render } from '@react-email/render';
import PasswordResetEmail from '../emails/password-reset';

const FROM_EMAIL = 'feedback@askansari.ai';

function getResendClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is required');
  }
  return new Resend(apiKey);
}

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'https://askansari.ai';
    const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

    const html = await render(PasswordResetEmail({ resetUrl }));

    const resend = getResendClient();
    const { error } = await resend.emails.send({
      from: `Ansari <${FROM_EMAIL}>`,
      to,
      subject: 'Ansari Password Reset',
      html,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}
