import { afterEach, describe, expect, it, vi } from 'vitest';

// Force the web branch of the store (SecureStore is native-only). Both modules
// are mocked so this suite runs under Node without the React Native runtime.
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { saveSession, type StoredSession } from '@/lib/auth/store';

const session: StoredSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  firstName: 'Test',
  lastName: 'User',
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
