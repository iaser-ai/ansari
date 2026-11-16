/**
 * Feature flag for third-party social authentication (Google and Apple).
 *
 * Disabled by default so the application launches with email/password authentication only.
 * Set `EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=true` in `.env.local` or deployment environment
 * to show Apple and Google buttons in AuthSheet.
 */
export function isSocialAuthEnabled(): boolean {
  const flag =
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH ??
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN ??
    process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH;
  return flag === "true" || flag === "1";
}
