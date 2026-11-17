/**
 * Feature flag for third-party social authentication (Google and Apple).
 *
 * Disabled by default so the application launches with email/password authentication only.
 * Set `EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=true` in `.env.local` or deployment environment
 * to show Apple and Google buttons in AuthSheet.
 */
export function isSocialAuthEnabled(): boolean {
  const candidates = [
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH,
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN,
    process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH,
    process.env.EXPO_PUBLIC_SOCIAL_AUTH,
    process.env.EXPO_PUBLIC_MOCK_AUTH,
  ];
  const flag = candidates.find(
    (c) =>
      typeof c === "string" &&
      c.trim().length > 0 &&
      c.trim() !== "undefined" &&
      c.trim() !== "null"
  );
  const normalized = flag?.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "error" ||
    normalized === "cancel" ||
    normalized === "network-error"
  );
}
