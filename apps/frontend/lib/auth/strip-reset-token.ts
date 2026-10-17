// Side effect only, imported FIRST by the app entry (index.ts): on the web,
// a reset link's `?token=` moves into memory before expo-router loads.
//
// Gated on Platform.OS, not on `window`: React Native defines a global
// `window` with no `location` or `history`, and reading them there red-boxes
// the app before the router loads (it did, #311).
import { Platform } from 'react-native';

import { takeResetTokenFromUrl } from '@/lib/auth/reset-token';

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  takeResetTokenFromUrl(window);
}
