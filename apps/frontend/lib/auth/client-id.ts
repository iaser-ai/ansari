import { Platform } from 'react-native';

import { CLIENT_IDS } from '@/lib/auth/client-id-values';

export { CLIENT_IDS };

/** The `X-Ansari-Client` id for this platform (`client-id-values.ts`). */
export function clientId(os: string = Platform.OS): string {
  if (os === 'ios') return CLIENT_IDS.ios;
  if (os === 'android') return CLIENT_IDS.android;
  return CLIENT_IDS.web;
}
