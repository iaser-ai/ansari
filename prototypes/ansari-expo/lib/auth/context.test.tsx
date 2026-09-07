// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the storage + network layers so the provider runs under jsdom with no
// React Native runtime and no real requests.
vi.mock('@/lib/auth/store', () => ({
  loadSession: vi.fn(async () => null),
  saveSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
  loadGuestCredentials: vi.fn(async () => null),
  saveGuestCredentials: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/api', () => ({
  loginRequest: vi.fn(async (email: string) => ({
    accessToken: `access-${email}`,
    refreshToken: `refresh-${email}`,
    firstName: 'X',
    lastName: 'Y',
  })),
  registerRequest: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r' })),
  refreshRequest: vi.fn(async () => ({ accessToken: 'a2', refreshToken: 'r2' })),
  logoutRequest: vi.fn(async () => {}),
}));

import * as store from '@/lib/auth/store';
import * as authApiModule from '@/lib/auth/api';
import { AuthProvider, useAuth } from '@/lib/auth/context';

const loadSessionMock = vi.mocked(store.loadSession);
const registerRequestMock = vi.mocked(authApiModule.registerRequest);

let authApi!: ReturnType<typeof useAuth>;

function Probe() {
  authApi = useAuth();
  return <span>{authApi.status}</span>;
}

afterEach(() => {
  cleanup();
  loadSessionMock.mockResolvedValue(null);
  registerRequestMock.mockClear();
});

/**
 * Mount and let startup settle. With nothing stored, the provider auto-provisions
 * a GUEST session (`apps/api` has no anonymous path), so the settled state is
 * `signedIn` as a guest — not `signedOut`.
 */
async function mount(queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(authApi.status).not.toBe('loading'));
}

/**
 * Issue #124: `apps/api` returns 401 for any thread call without a bearer token
 * and has no anonymous path, so a tokenless "signed-out" app is broken. The
 * provider must auto-provision a guest — on first launch with nothing stored,
 * and again after logout — so the app is never tokenless.
 */
describe('AuthProvider auto-provisions a guest session', () => {
  it('first launch with no stored session lands signed-in as a guest', async () => {
    const queryClient = new QueryClient();
    await mount(queryClient);

    expect(authApi.status).toBe('signedIn');
    expect(authApi.isGuest).toBe(true);
    // The guest was registered (no cached credentials in this run).
    expect(registerRequestMock).toHaveBeenCalledTimes(1);
  });

  it('restores a real stored session without minting a guest', async () => {
    loadSessionMock.mockResolvedValueOnce({
      accessToken: 'real-access',
      refreshToken: 'real-refresh',
      firstName: 'Real',
      lastName: 'User',
      isGuest: false,
    });
    const queryClient = new QueryClient();
    await mount(queryClient);

    expect(authApi.status).toBe('signedIn');
    expect(authApi.isGuest).toBe(false);
    expect(registerRequestMock).not.toHaveBeenCalled();
  });
});

/**
 * BLOCKER 2 regression: cached, user-scoped queries must not outlive a principal
 * transition, or one account's threads render for the next (routine here via the
 * guest → register flow on one device). Without the `queryClient.clear()` in
 * `applySession`, both assertions below fail — the seeded data survives.
 */
describe('AuthProvider clears the query cache on principal transitions', () => {
  it('signing in as a real account wipes the guest cache', async () => {
    const queryClient = new QueryClient();
    await mount(queryClient); // signed in as guest

    queryClient.setQueryData(['conversations'], [{ id: 'A-thread', title: 'A secret' }]);
    expect(queryClient.getQueryData(['conversations'])).toBeTruthy();

    await act(async () => {
      await authApi.login('b@example.com', 'pw');
    });

    expect(authApi.status).toBe('signedIn');
    expect(authApi.isGuest).toBe(false);
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });

  it('logging out of a real account wipes the cache and drops back to a guest', async () => {
    const queryClient = new QueryClient();
    await mount(queryClient);

    await act(async () => {
      await authApi.login('a@example.com', 'pw');
    });
    expect(authApi.isGuest).toBe(false);
    queryClient.setQueryData(['conversations'], [{ id: 'A-thread' }]);
    expect(queryClient.getQueryData(['conversations'])).toBeTruthy();

    await act(async () => {
      await authApi.logout();
    });

    // logout clears the cache, then the app falls straight back to a guest.
    await waitFor(() => expect(authApi.isGuest).toBe(true));
    expect(authApi.status).toBe('signedIn');
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });
});
