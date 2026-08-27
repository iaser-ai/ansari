import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

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
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // ignore quota / unavailable storage
    }
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
  if (nameRaw) {
    try {
      const parsed = JSON.parse(nameRaw) as { firstName?: string; lastName?: string };
      firstName = parsed.firstName ?? '';
      lastName = parsed.lastName ?? '';
    } catch {
      // corrupt name blob is non-fatal
    }
  }
  return { accessToken, refreshToken, firstName, lastName };
}

export async function saveSession(session: StoredSession): Promise<void> {
  await Promise.all([
    setItem(ACCESS_KEY, session.accessToken),
    setItem(REFRESH_KEY, session.refreshToken),
    setItem(
      NAME_KEY,
      JSON.stringify({ firstName: session.firstName, lastName: session.lastName }),
    ),
  ]);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    deleteItem(ACCESS_KEY),
    deleteItem(REFRESH_KEY),
    deleteItem(NAME_KEY),
  ]);
}
