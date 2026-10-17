// The opt-in newsletter subscribe, ported from apps/api/lib/newsletter.ts
// (spec 300). Sign-up moves to apps/auth, so the subscribe moves with it:
// createAuth()'s `hooks.after` on `/sign-up/email` calls it when the body
// carries `register_to_mail_list: true`, and never otherwise (CAN-SPAM / GDPR).
//
// Fire-and-forget at the call site: a failure here never fails a sign-up.

export interface SubscribeResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

let announcedUnconfigured = false;

/**
 * POST the subscriber to MARKETMAKER_URL. When the URL is unset the
 * integration is disabled: the call is skipped (logged once, no error).
 */
export async function subscribeToNewsletter(
  marketmakerUrl: string | undefined,
  email: string,
  firstName: string | null,
  lastName: string | null
): Promise<SubscribeResult> {
  if (!marketmakerUrl) {
    if (!announcedUnconfigured) {
      console.log('MARKETMAKER_URL is not set — newsletter subscriptions are disabled.');
      announcedUnconfigured = true;
    }
    return { success: true, skipped: true };
  }

  const payload = {
    email,
    name: `${firstName ?? ''} ${lastName ?? ''}`.trim(),
    projectSlug: 'ansari',
    interests: ['islamic'],
  };

  try {
    const response = await fetch(marketmakerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Status only: the body of a failed subscribe may echo the email back.
      return { success: false, error: `HTTP ${response.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.name : 'unknown error' };
  }
}
