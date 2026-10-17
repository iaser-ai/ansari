// @vitest-environment jsdom
// The two password-reset routes (#304), `app/forgot-password.tsx` and
// `app/reset-password.tsx`. Tests live here because a file under `app/`
// is a route. The page chrome (`AuthPage`) is stood in for: what is under
// test is what each page sends, shows and keeps out of the address. How the
// web token leaves the URL before the router loads is tested against a real
// location/history in lib/auth/reset-token.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const routerDouble = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  setParams: vi.fn(),
}));
const searchParams = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock('expo-router', () => ({
  router: routerDouble,
  useLocalSearchParams: () => searchParams.current,
}));
vi.mock('@/components/PressableScale', async () => {
  const { Pressable } = await import('react-native');
  return { PressableScale: Pressable };
});
// A plain text input: react-native-web renders an email field as
// type="email", whose value the DOM itself strips of surrounding spaces,
// which would hide whether the screen trims (a native field does not).
vi.mock('@/components/AuthField', () => ({
  Field: ({
    value,
    onChangeText,
    testID,
  }: {
    value: string;
    onChangeText: (next: string) => void;
    testID: string;
  }) => (
    <input data-testid={testID} value={value} onChange={(e) => onChangeText(e.target.value)} />
  ),
}));
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
const authApiDouble = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));
vi.mock('@/lib/auth/client', () => ({ authApi: authApiDouble }));
const openAuthSheet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authSheet', () => ({ openAuthSheet }));
const checkSession = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/auth/context', () => ({ useAuth: () => ({ checkSession }) }));

import { AuthError } from '@/lib/auth/api';
import { handOverResetToken, peekResetToken, takeResetToken } from '@/lib/auth/reset-token';
import ForgotPasswordScreen from '@/app/forgot-password';
import ResetPasswordScreen from '@/app/reset-password';

const TOKEN = 'reset-token-abcdef0123456789';
const type = (testID: string, value: string) =>
  fireEvent.change(screen.getByTestId(testID), { target: { value } });
const press = async (testID: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testID));
  });
};

let consoleCalls: unknown[][];
beforeEach(() => {
  searchParams.current = {};
  takeResetToken();
  consoleCalls = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('/forgot-password', () => {
  it('asks apps/auth for a reset with the trimmed email, then says "if an account exists"', async () => {
    authApiDouble.requestPasswordReset.mockResolvedValue(undefined);
    render(<ForgotPasswordScreen />);
    type('email-input', '  reader@example.com ');
    await press('reset-request-submit');
    expect(authApiDouble.requestPasswordReset).toHaveBeenCalledWith('reader@example.com');
    expect(screen.getByTestId('reset-request-sent').textContent).toMatch(
      /If an account exists for reader@example\.com/,
    );
  });

  it('shows the same confirmation for an address no account holds (no oracle)', async () => {
    authApiDouble.requestPasswordReset.mockResolvedValue(undefined);
    render(<ForgotPasswordScreen />);
    type('email-input', 'known@example.com');
    await press('reset-request-submit');
    const known = screen.getByTestId('reset-request-sent').textContent?.replace('known@', 'X@');
    cleanup();
    render(<ForgotPasswordScreen />);
    type('email-input', 'nobody@example.com');
    await press('reset-request-submit');
    const unknown = screen.getByTestId('reset-request-sent').textContent?.replace('nobody@', 'X@');
    expect(unknown).toBe(known);
  });

  it('an empty email is refused before any request', async () => {
    render(<ForgotPasswordScreen />);
    await press('reset-request-submit');
    expect(authApiDouble.requestPasswordReset).not.toHaveBeenCalled();
    expect(screen.getByTestId('reset-error')).toBeTruthy();
  });

  it.each([
    [429, /Too many reset requests for this address\. Try again later\./],
    [503, /can't be reached right now/],
    [0, /can't be reached right now/],
  ])('a %s is an error with its own text, not a confirmation', async (status, message) => {
    authApiDouble.requestPasswordReset.mockRejectedValue(
      new AuthError('generic client text', status, 'request-password-reset'),
    );
    render(<ForgotPasswordScreen />);
    type('email-input', 'reader@example.com');
    await press('reset-request-submit');
    expect(screen.getByTestId('reset-error').textContent).toMatch(message);
    expect(screen.queryByTestId('reset-request-sent')).toBeNull();
  });

  it('"Back to sign in" raises the sign-in sheet over the home screen', async () => {
    render(<ForgotPasswordScreen />);
    await press('back-to-sign-in');
    expect(openAuthSheet).toHaveBeenCalledWith('login');
    expect(routerDouble.replace).toHaveBeenCalledWith('/');
  });
});

describe('/reset-password', () => {
  /** The clean page, with the token where the web entry or the native link page left it. */
  function openClean(token: string | null = TOKEN) {
    handOverResetToken(token);
    searchParams.current = {};
    return render(<ResetPasswordScreen />);
  }

  it('native: the link page hands the token over and replaces itself with a plain /reset-password', () => {
    searchParams.current = { token: TOKEN };
    render(<ResetPasswordScreen />);
    expect(routerDouble.replace).toHaveBeenCalledWith('/reset-password');
    expect(JSON.stringify(routerDouble.replace.mock.calls)).not.toContain(TOKEN);
    expect(screen.queryByTestId('new-password-input')).toBeNull();
    expect(peekResetToken()).toBe(TOKEN);
    // The replacement page, as the router mounts it.
    cleanup();
    searchParams.current = {};
    render(<ResetPasswordScreen />);
    expect(screen.getByTestId('new-password-input')).toBeTruthy();
  });

  it('the clean page takes the token on mount: the slot is empty while the form is up', () => {
    openClean();
    expect(screen.getByTestId('new-password-input')).toBeTruthy();
    expect(peekResetToken()).toBeNull();
  });

  it('sets the new password with the token, checks this device session, then sends the reader to sign in', async () => {
    authApiDouble.resetPassword.mockResolvedValue(undefined);
    openClean();
    type('new-password-input', 'New-pass-123!');
    type('confirm-password-input', 'New-pass-123!');
    await press('reset-submit');
    expect(authApiDouble.resetPassword).toHaveBeenCalledWith(TOKEN, 'New-pass-123!');
    expect(screen.getByText('Password changed')).toBeTruthy();
    expect(checkSession).toHaveBeenCalledTimes(1);
    await press('reset-sign-in');
    expect(openAuthSheet).toHaveBeenCalledWith('login');
    expect(routerDouble.replace).toHaveBeenCalledWith('/');
  });

  it('a failed reset does not touch this device session', async () => {
    authApiDouble.resetPassword.mockRejectedValue(new AuthError('Too weak', 400, 'reset-password'));
    openClean();
    type('new-password-input', 'weakweak');
    type('confirm-password-input', 'weakweak');
    await press('reset-submit');
    expect(checkSession).not.toHaveBeenCalled();
  });

  it('a reload (no token in memory) asks to open the link again, not "no longer works"', () => {
    openClean(null);
    expect(screen.getByText('Open your reset link')).toBeTruthy();
    expect(screen.getByText('Open the link from your email again, or ask for a new one.')).toBeTruthy();
    expect(screen.queryByText('This link no longer works')).toBeNull();
    expect(screen.queryByTestId('new-password-input')).toBeNull();
  });

  it.each([
    ['too short', 'short', 'short', /at least 8/],
    ['mismatched', 'New-pass-123!', 'New-pass-124!', /do not match/],
  ])('a %s password is refused before any request', async (_label, pw, confirm, message) => {
    openClean();
    type('new-password-input', pw);
    type('confirm-password-input', confirm);
    await press('reset-submit');
    expect(authApiDouble.resetPassword).not.toHaveBeenCalled();
    expect(screen.getByTestId('reset-error').textContent).toMatch(message);
  });

  it('a token apps/auth refuses (expired, used) says the link no longer works', async () => {
    authApiDouble.resetPassword.mockRejectedValue(
      new AuthError('Invalid or expired reset token', 400, 'reset-password'),
    );
    openClean();
    type('new-password-input', 'New-pass-123!');
    type('confirm-password-input', 'New-pass-123!');
    await press('reset-submit');
    expect(screen.getByText('This link no longer works')).toBeTruthy();
    await press('reset-request-new');
    expect(routerDouble.replace).toHaveBeenCalledWith('/forgot-password');
  });

  it("a weak password shows apps/auth's message and keeps the form", async () => {
    authApiDouble.resetPassword.mockRejectedValue(
      new AuthError('Password is too weak. Use a mix of letters, numbers and symbols.', 400, 'reset-password'),
    );
    openClean();
    type('new-password-input', 'weakweak');
    type('confirm-password-input', 'weakweak');
    await press('reset-submit');
    expect(screen.getByTestId('reset-error').textContent).toMatch(/too weak/);
    expect(screen.getByTestId('new-password-input')).toBeTruthy();
  });

  it.each([503, 0])('a %s says Ansari cannot be reached (not "sign-in is unavailable")', async (status) => {
    authApiDouble.resetPassword.mockRejectedValue(
      new AuthError('Sign-in is unavailable right now. Please try again shortly.', status, 'reset-password'),
    );
    openClean();
    type('new-password-input', 'New-pass-123!');
    type('confirm-password-input', 'New-pass-123!');
    await press('reset-submit');
    expect(screen.getByTestId('reset-error').textContent).toMatch(/can't be reached right now/);
    expect(screen.getByTestId('reset-error').textContent).not.toMatch(/Sign-in/);
  });

  it('the token is never logged and never rendered, on any outcome', async () => {
    for (const outcome of ['ok', 'dead', 'weak', 'network'] as const) {
      cleanup();
      authApiDouble.resetPassword.mockReset();
      if (outcome === 'ok') authApiDouble.resetPassword.mockResolvedValue(undefined);
      if (outcome === 'dead')
        authApiDouble.resetPassword.mockRejectedValue(
          new AuthError('Invalid or expired reset token', 400, 'reset-password'),
        );
      if (outcome === 'weak')
        authApiDouble.resetPassword.mockRejectedValue(new AuthError('Too weak', 400, 'reset-password'));
      if (outcome === 'network')
        authApiDouble.resetPassword.mockRejectedValue(new AuthError("Couldn't reach Ansari.", 0, 'reset-password'));
      openClean();
      type('new-password-input', 'New-pass-123!');
      type('confirm-password-input', 'New-pass-123!');
      await press('reset-submit');
      await waitFor(() => expect(authApiDouble.resetPassword).toHaveBeenCalled());
      expect(document.body.innerHTML).not.toContain(TOKEN);
    }
    expect(JSON.stringify(consoleCalls)).not.toContain(TOKEN);
  });

  it('the checks can fail (near-misses: a rendered token and a logged token are both found)', () => {
    render(<span>{TOKEN}</span>);
    expect(document.body.innerHTML).toContain(TOKEN);
    console.log('reset token', TOKEN);
    expect(JSON.stringify(consoleCalls)).toContain(TOKEN);
  });
});
