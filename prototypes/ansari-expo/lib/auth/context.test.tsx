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

import { AuthProvider, useAuth } from '@/lib/auth/context';

let authApi!: ReturnType<typeof useAuth>;

function Probe() {
  authApi = useAuth();
  return <span>{authApi.status}</span>;
}

afterEach(() => cleanup());

async function mount(queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  // Flush the startup loadSession effect (resolves to signed-out).
  await waitFor(() => expect(authApi.status).not.toBe('loading'));
}

/**
 * BLOCKER 2 regression: cached, user-scoped queries must not outlive a principal
 * transition, or one account's threads render for the next (routine here via the
 * guest → register flow on one device). Without the `queryClient.clear()` in
 * `applySession`, both assertions below fail — the seeded data survives.
 */
describe('AuthProvider clears the query cache on principal transitions', () => {
  it('signing in as a different account wipes the previous account cache', async () => {
    const queryClient = new QueryClient();
    await mount(queryClient);

    queryClient.setQueryData(['conversations'], [{ id: 'A-thread', title: 'A secret' }]);
    expect(queryClient.getQueryData(['conversations'])).toBeTruthy();

    await act(async () => {
      await authApi.login('b@example.com', 'pw');
    });

    expect(authApi.status).toBe('signedIn');
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });

  it('logging out wipes the cache', async () => {
    const queryClient = new QueryClient();
    await mount(queryClient);

    await act(async () => {
      await authApi.login('a@example.com', 'pw');
    });
    queryClient.setQueryData(['conversations'], [{ id: 'A-thread' }]);
    expect(queryClient.getQueryData(['conversations'])).toBeTruthy();

    await act(async () => {
      await authApi.logout();
    });

    expect(authApi.status).toBe('signedOut');
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });
});
