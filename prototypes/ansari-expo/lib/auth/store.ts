import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { GUEST_FIRST_NAME, GUEST_LAST_NAME } from '@/lib/auth/guest';

/**
 * Persistent storage for the session's REAL staging credentials.
 *
 * - Native (iOS/Android): `expo-secure-store` (Keychain / Keystore).
 * - Web: `localStorage`. SecureStore is unavailable on web; localStorage is
 *   XSS-reachable in principle. That is acceptable HERE only because these are
 *   staging credentials in a throwaway prototype — do NOT carry this pattern
 *   into the real app (see README).
 *
 * Tokens are never logged. Access and refresh tokens are stored under separate
 * keys (a single JSON blob of both can exceed SecureStore's per-item size cap on
 * Android); the display name is a tiny JSON blob.
 */

const ACCESS_KEY = 'ansari.accessToken';
const REFRESH_KEY = 'ansari.refreshToken';
const NAME_KEY = 'ansari.userName';
// Guest email+password persist ACROSS logout (unlike the session keys above) so a
// device reuses its one guest account instead of minting a new staging user on
// every "Continue as guest" tap.
const GUEST_KEY = 'ansari.guestCredentials';

const isWeb = Platform.OS === 'web';

async function getItem(key: string): Promise<string | null> {
  if (isWeb) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    // Loud failure: a write that silently fails would let a login "succeed"
    // without persisting, so the next cold start is unexpectedly signed out.
    // Let quota/security errors — and a missing localStorage — propagate so the
    // caller (saveSession / saveGuestCredentials) surfaces them.
    if (!globalThis.localStorage) {
      throw new Error('Local storage is unavailable; the session cannot be saved.');
    }
    globalThis.localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteItem(key: string): Promise<void> {
  if (isWeb) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // ignore
    }
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  firstName: string;
  lastName: string;
  /**
   * True for an auto-provisioned guest session (see `context.tsx` /
   * `lib/auth/guest`). The UI shows the "sign in" upsell rather than a
   * "log out" affordance for a guest. On load, the guest registration name
   * (`GUEST_FIRST_NAME`/`GUEST_LAST_NAME` in `lib/auth/guest`) also marks a
   * guest whatever the stored flag says — absent (pre-field blobs, #208) or a
   * stale literal `false` (#253) — since every guest account carries that
   * name and a real account almost never will.
   */
  isGuest: boolean;
}

export async function loadSession(): Promise<StoredSession | null> {
  const [accessToken, refreshToken, nameRaw] = await Promise.all([
    getItem(ACCESS_KEY),
    getItem(REFRESH_KEY),
    getItem(NAME_KEY),
  ]);
  if (!accessToken || !refreshToken) return null;
  let firstName = '';
  let lastName = '';
  let isGuest = false;
  if (nameRaw) {
    try {
      const parsed = JSON.parse(nameRaw) as {
        firstName?: string;
        lastName?: string;
        isGuest?: boolean;
      };
      firstName = parsed.firstName ?? '';
      lastName = parsed.lastName ?? '';
      // The guest registration name is authoritative, not merely a fallback
      // for a missing key: a stale blob can carry a literal `isGuest: false`
      // (#253), which `??` would keep. A real account registered as exactly
      // "Welcome Guest" would read as a guest; we accept that edge case.
      isGuest =
        parsed.isGuest === true ||
        (firstName === GUEST_FIRST_NAME && lastName === GUEST_LAST_NAME);
    } catch {
      // corrupt name blob is non-fatal
    }
  }
  return { accessToken, refreshToken, firstName, lastName, isGuest };
}

export async function saveSession(session: StoredSession): Promise<void> {
  await Promise.all([
    setItem(ACCESS_KEY, session.accessToken),
    setItem(REFRESH_KEY, session.refreshToken),
    setItem(
      NAME_KEY,
      JSON.stringify({
        firstName: session.firstName,
        lastName: session.lastName,
        isGuest: session.isGuest,
      }),
    ),
  ]);
}

export async function clearSession(): Promise<void> {
  // Note: does NOT touch the guest credentials — logging out of a guest and
  // tapping "Continue as guest" again must return to the SAME guest account.
  await Promise.all([
    deleteItem(ACCESS_KEY),
    deleteItem(REFRESH_KEY),
    deleteItem(NAME_KEY),
  ]);
}

export interface GuestCredentials {
  email: string;
  password: string;
}

export async function loadGuestCredentials(): Promise<GuestCredentials | null> {
  const raw = await getItem(GUEST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GuestCredentials>;
    if (parsed.email && parsed.password) {
      return { email: parsed.email, password: parsed.password };
    }
  } catch {
    // corrupt blob → treat as absent so a fresh guest is minted
  }
  return null;
}

export async function saveGuestCredentials(
  credentials: GuestCredentials,
): Promise<void> {
  await setItem(GUEST_KEY, JSON.stringify(credentials));
}

export async function clearGuestCredentials(): Promise<void> {
  await deleteItem(GUEST_KEY);
}
