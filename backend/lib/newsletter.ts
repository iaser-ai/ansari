export interface SubscribeResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

let announcedUnconfigured = false;

export async function subscribeToNewsletter(
  email: string,
  firstName: string | null,
  lastName: string | null,
): Promise<SubscribeResult> {
  // Optional integration: when MARKETMAKER_URL is unset, newsletter subscriptions
  // are disabled and subscribe calls are silently skipped (logged once, no Sentry).
  const marketmakerUrl = process.env.MARKETMAKER_URL;
  if (!marketmakerUrl) {
    if (!announcedUnconfigured) {
      console.log('MARKETMAKER_URL is not set — newsletter subscriptions are disabled.');
      announcedUnconfigured = true;
    }
    return { success: true, skipped: true };
  }

  const name = `${firstName ?? ''} ${lastName ?? ''}`.trim();
  const payload = {
    email,
    name,
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
      const text = await response.text().catch(() => 'unknown');
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export function createThrottledSubscriber(
  ratePerMinute: number,
): (email: string, firstName: string | null, lastName: string | null) => Promise<SubscribeResult> {
  const intervalMs = Math.ceil(60_000 / ratePerMinute);
  let lastCallTime = 0;

  return async (email, firstName, lastName) => {
    const now = Date.now();
    const elapsed = now - lastCallTime;
    if (elapsed < intervalMs) {
      await sleep(intervalMs - elapsed);
    }
    lastCallTime = Date.now();
    return subscribeToNewsletter(email, firstName, lastName);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
