// @vitest-environment jsdom
// `app/delete-account.tsx` (#306). Tests live here because a file under
// `app/` is a route. The page chrome (`AuthPage`) is stood in for.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const routerDouble = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('expo-router', () => ({ router: routerDouble }));
vi.mock('@/components/PressableScale', async () => {
  const { Pressable } = await import('react-native');
  return { PressableScale: Pressable };
});
vi.mock('@/components/AuthPage', () => ({
  AuthPage: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="auth-page">
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </div>
  ),
  authPageStyles: {},
}));
const openAuthSheet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authSheet', () => ({ openAuthSheet }));

type AuthState = {
  status: 'loading' | 'signedIn' | 'signedOut';
  isGuest: boolean;
  session: { firstName: string; lastName: string } | null;
};
const auth = vi.hoisted(() => ({
  state: {} as AuthState,
  deleteAccount: vi.fn(),
}));
vi.mock('@/lib/auth/context', () => ({
  useAuth: () => ({ ...auth.state, deleteAccount: auth.deleteAccount }),
}));

import { ApiError } from '@/vendor/api-client-react/custom-fetch';
import { AccountDeleteNotSentError, AccountSessionEndedError } from '@/lib/auth/errors';
import DeleteAccountScreen from '@/app/delete-account';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const press = async (testID: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testID));
  });
};

function signedInAs(state: AuthState) {
  auth.state = state;
  return render(<DeleteAccountScreen />);
}

const REAL: AuthState = {
  status: 'signedIn',
  isGuest: false,
  session: { firstName: 'Amina', lastName: 'Yusuf' },
};

function apiError(status: number): ApiError {
  return new ApiError(new Response(null, { status }), null, { method: 'DELETE', url: '/api/v2/users/me' });
}

describe('/delete-account for a visitor with no account of their own', () => {
  it.each([
    ['a guest', { status: 'signedIn', isGuest: true, session: { firstName: 'Welcome', lastName: 'Guest' } }],
    ['nobody (signed out)', { status: 'signedOut', isGuest: false, session: null }],
    // A public page: a visitor with nothing stored is held at `loading`
    // (no guest is provisioned for them) and must still get the prompt.
    ['a fresh visitor (loading, nothing restored)', { status: 'loading', isGuest: false, session: null }],
  ] as const)('%s is asked to sign in, and offered no delete', async (_label, state) => {
    signedInAs(state as AuthState);
    expect(screen.getByText('Delete your account')).toBeTruthy();
    expect(screen.queryByTestId('delete-start')).toBeNull();
    expect(screen.queryByTestId('delete-confirm')).toBeNull();
    await press('delete-sign-in');
    expect(openAuthSheet).toHaveBeenCalledWith('login');
    expect(auth.deleteAccount).not.toHaveBeenCalled();
  });
});

describe('/delete-account for a signed-in account', () => {
  it('names what is deleted, and the first press only asks for confirmation', async () => {
    signedInAs(REAL);
    expect(screen.getByText('Signed in as Amina Yusuf.')).toBeTruthy();
    expect(screen.getByTestId('delete-what').textContent).toMatch(/every question you have asked/);
    await press('delete-start');
    expect(auth.deleteAccount).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-confirm')).toBeTruthy();
  });

  it('cancel leaves everything intact', async () => {
    signedInAs(REAL);
    await press('delete-start');
    await press('delete-cancel');
    expect(auth.deleteAccount).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-start')).toBeTruthy();
  });

  it('confirming deletes, then the page says the account is gone (not the guest prompt)', async () => {
    auth.deleteAccount.mockImplementation(async () => {
      // The provider's signed-out transition lands the device on its guest.
      auth.state = { status: 'signedIn', isGuest: true, session: { firstName: 'Welcome', lastName: 'Guest' } };
    });
    const view = signedInAs(REAL);
    await press('delete-start');
    await press('delete-confirm');
    view.rerender(<DeleteAccountScreen />);
    expect(auth.deleteAccount).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Your account has been deleted')).toBeTruthy();
    expect(screen.queryByTestId('delete-sign-in')).toBeNull();
    await press('delete-done');
    expect(routerDouble.replace).toHaveBeenCalledWith('/');
  });

  it.each([
    ['a 503', () => apiError(503)],
    ['a 500', () => apiError(500)],
    ['a network failure', () => new TypeError('Network request failed')],
    ['an unexpected error (raw text never shown)', () => new Error('internal detail: pool exhausted')],
  ])('%s cannot say whether it committed: "could not confirm", the confirm step kept', async (_label, error) => {
    auth.deleteAccount.mockRejectedValue(error());
    signedInAs(REAL);
    await press('delete-start');
    await press('delete-confirm');
    const text = screen.getByTestId('delete-error').textContent ?? '';
    expect(text).toMatch(/couldn't confirm the deletion/);
    expect(text).toMatch(/If this device has been signed out, your account is gone/);
    expect(text).not.toMatch(/Nothing was deleted|internal detail|Network request/);
    expect(screen.getByTestId('delete-confirm')).toBeTruthy();
  });

  it('nothing sent (the fresh JWT could not be minted): a plain retry, not "could not confirm"', async () => {
    auth.deleteAccount.mockRejectedValue(new AccountDeleteNotSentError());
    signedInAs(REAL);
    await press('delete-start');
    await press('delete-confirm');
    const text = screen.getByTestId('delete-error').textContent ?? '';
    expect(text).toBe("We couldn't reach Ansari, so nothing was deleted. Try again.");
    expect(text).not.toMatch(/couldn't confirm|your account is gone/);
    expect(screen.getByTestId('delete-confirm')).toBeTruthy();
  });

  it('a 401 (the session was already dead) says so honestly, not a sign-in prompt', async () => {
    auth.deleteAccount.mockImplementation(async () => {
      auth.state = { status: 'signedOut', isGuest: false, session: null };
      throw new AccountSessionEndedError();
    });
    const view = signedInAs(REAL);
    await press('delete-start');
    await press('delete-confirm');
    view.rerender(<DeleteAccountScreen />);
    expect(screen.getByText('Your session has ended')).toBeTruthy();
    expect(screen.getByText(/If you already confirmed, your account is deleted/)).toBeTruthy();
    expect(screen.queryByTestId('delete-sign-in')).toBeNull();
    await press('delete-ended');
    expect(routerDouble.replace).toHaveBeenCalledWith('/');
  });
});
