/**
 * Parses MAINTENANCE_MODE exactly as apps/api/lib/config.ts does: 'true', 'True' and '1' are on.
 * Unset, empty, 'false', 'False', '0' and any other value are OFF, so an unset variable never
 * shows the maintenance screen.
 */
export const parseMaintenanceMode = (value: string | undefined): boolean =>
  value === 'true' || value === 'True' || value === '1'

const envConfig = {
  API_URL: () => process.env.EXPO_PUBLIC_API_V2_URL!,
  SHARE_URL: () => process.env.EXPO_PUBLIC_SHARE_URL!,
  LOADING_MESSAGE_RESPONSE_TIMEOUT: () =>
    process.env.EXPO_PUBLIC_API_TIMEOUT ? Number.parseInt(process.env.EXPO_PUBLIC_API_TIMEOUT) : 60000,
  FEEDBACK_EMAIL: () => process.env.EXPO_PUBLIC_FEEDBACK_EMAIL,
  FEEDBACK_MAIL_TO: () => `mailto:${process.env.EXPO_PUBLIC_FEEDBACK_EMAIL}`,
  COMPREHENSIVE_GUIDE_URL: () => process.env.EXPO_PUBLIC_COMPREHENSIVE_GUIDE_URL!,
  PRIVACY_URL: () => process.env.EXPO_PUBLIC_PRIVACY_URL!,
  TERMS_URL: () => process.env.EXPO_PUBLIC_TERMS_URL!,
  SUBSCRIBE_URL: () => process.env.EXPO_PUBLIC_SUBSCRIBE_URL!,
  ENABLE_SHARE: () => process.env.EXPO_PUBLIC_ENABLE_SHARE === 'true',
  // Inlined by Expo at BUILD time (the Dockerfile maps the MAINTENANCE_MODE build arg to it):
  // changing it takes a rebuild, and an already-loaded tab keeps its value until it reloads.
  MAINTENANCE_MODE: () => parseMaintenanceMode(process.env.EXPO_PUBLIC_MAINTENANCE_MODE),
}

const getEnv = <T extends keyof typeof envConfig>(key: T) => {
  return envConfig[key]() as ReturnType<(typeof envConfig)[T]>
}

export default getEnv
