import { afterEach, describe, expect, it, vi } from 'vitest';

// Force the web branch of the store (SecureStore is native-only). Both modules
// are mocked so this suite runs under Node without the React Native runtime.
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { loadSession, saveSession, type StoredSession } from '@/lib/auth/store';

const session: StoredSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  firstName: 'Test',
  lastName: 'User',
  isGuest: false,
};

/**
 * Proves fix (3): the web store must fail LOUDLY when a write can't persist, so a
 * login can never "succeed" without saving. If the guard were removed (setItem
 * swallowing errors again), cases (a) and (b) would resolve instead of reject and
 * these tests would fail — which is the point.
 */
describe('saveSession — web storage failures are loud', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (descriptor) {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    vi.restoreAllMocks();
  });

  it('(a) rejects when localStorage is unavailable', async () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    await expect(saveSession(session)).rejects.toThrow(/unavailable/i);
  });

  it('(b) rejects when localStorage.setItem throws QuotaExceededError', async () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      setItem: () => {
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      },
      getItem: () => null,
      removeItem: () => {},
    };
    await expect(saveSession(session)).rejects.toThrow(/quota/i);
  });

  it('(c) resolves and persists when localStorage works', async () => {
    const backing = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      setItem: (key: string, value: string) => backing.set(key, value),
      getItem: (key: string) => backing.get(key) ?? null,
      removeItem: (key: string) => backing.delete(key),
    };
    await expect(saveSession(session)).resolves.toBeUndefined();
    expect(backing.get('ansari.accessToken')).toBe('access-token');
    expect(backing.get('ansari.refreshToken')).toBe('refresh-token');
  });
});

/**
 * Issue #208: a name blob persisted before `isGuest` existed has no such key.
 * Defaulting it to `false` rendered a guest as a real account ("Welcome Guest"
 * with a "Log out" button), so the guest registration name decides instead.
 */
describe('loadSession — isGuest inference from the stored blob', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (descriptor) {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  function storeNameBlob(nameBlob: Record<string, unknown>): void {
    const backing = new Map<string, string>([
      ['ansari.accessToken', 'access-token'],
      ['ansari.refreshToken', 'refresh-token'],
      ['ansari.userName', JSON.stringify(nameBlob)],
    ]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      setItem: (key: string, value: string) => backing.set(key, value),
      getItem: (key: string) => backing.get(key) ?? null,
      removeItem: (key: string) => backing.delete(key),
    };
  }

  it('infers a guest from the guest registration name', async () => {
    storeNameBlob({ firstName: 'Welcome', lastName: 'Guest' });
    expect((await loadSession())?.isGuest).toBe(true);
  });

  it('keeps a real account when the name differs', async () => {
    storeNameBlob({ firstName: 'Test', lastName: 'User' });
    expect((await loadSession())?.isGuest).toBe(false);
  });

  it('needs both halves of the guest name', async () => {
    storeNameBlob({ firstName: 'Welcome', lastName: 'User' });
    expect((await loadSession())?.isGuest).toBe(false);
  });

  it('an explicit isGuest: true wins over a non-guest name', async () => {
    storeNameBlob({ firstName: 'Test', lastName: 'User', isGuest: true });
    expect((await loadSession())?.isGuest).toBe(true);
  });

  it('an explicit isGuest: false on a non-guest name stays a real account', async () => {
    storeNameBlob({ firstName: 'Test', lastName: 'User', isGuest: false });
    expect((await loadSession())?.isGuest).toBe(false);
  });

  // Issue #253: a stale blob with a LITERAL `isGuest: false` and the guest
  // registration name must still load as a guest — `??` kept the `false`.
  it('rescues a stale literal isGuest: false on the guest name', async () => {
    storeNameBlob({ firstName: 'Welcome', lastName: 'Guest', isGuest: false });
    expect((await loadSession())?.isGuest).toBe(true);
  });
});
