// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

// Render through react-native-web: reanimated's animated wrappers are
// stood in for with plain ones, and its animation builders with no-ops.
vi.mock('react-native-reanimated', async () => {
  const { Text, View } = await import('react-native');
  const chain = (): unknown => new Proxy({}, { get: () => () => chain() });
  return {
    default: { View, Text },
    FadeIn: chain(),
    ReduceMotion: { System: 'system' },
    Easing: { bezier: () => () => 0 },
    cubicBezier: () => 'ease-out',
    useAnimatedStyle: (fn: () => object) => fn(),
  };
});
vi.mock('react-native-keyboard-controller', () => ({
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 } }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@/lib/haptics', () => ({ tapHaptic: () => {} }));
// A plain Pressable: the press-scale spring is not what is under test.
vi.mock('@/components/PressableScale', async () => {
  const { Pressable } = await import('react-native');
  return { PressableScale: Pressable };
});
vi.mock('@/components/AnsariMarkBrass', () => ({
  AnsariMarkBrass: () => null,
}));
vi.mock('@/components/BrandMarks', () => ({
  AppleMark: () => null,
  GoogleMark: () => null,
}));
// The sheet's chrome (drag, scrim, focus trap) is `Sheet`'s own concern
// and has nothing to do with what this card offers; stand it in with a
// plain container that is there while `open` and gone once it is not.
vi.mock('@/components/Sheet', () => ({
  Sheet: ({
    open,
    header,
    children,
  }: {
    open: boolean;
    header: React.ReactNode;
    children: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="sheet">
        {header}
        {children}
      </div>
    ) : null,
}));

const login = vi.fn(async () => {});
const register = vi.fn(async () => {});
const loginAsGuest = vi.fn(async () => {});
vi.mock('@/lib/auth/context', () => ({
  useAuth: () => ({ login, register, loginAsGuest }),
}));

import { AuthSheet } from '@/components/AuthSheet';
import { closeAuthSheet, openAuthSheet, useAuthSheet } from '@/lib/authSheet';

let mode: ReturnType<typeof useAuthSheet> = null;
function ModeProbe() {
  mode = useAuthSheet();
  return null;
}

afterEach(() => {
  act(() => closeAuthSheet());
  cleanup();
  vi.clearAllMocks();
});

function raise(face: 'login' | 'register') {
  render(
    <>
      <AuthSheet />
      <ModeProbe />
    </>,
  );
  act(() => openAuthSheet(face));
}

const type = (testID: string, value: string) =>
  fireEvent.change(screen.getByTestId(testID), { target: { value } });

describe('AuthSheet (issue #245)', () => {
  it('opens on the log-in face: email and password, no name fields', () => {
    raise('login');
    expect(screen.getByText('Welcome back')).toBeTruthy();
    expect(screen.getByTestId('email-input')).toBeTruthy();
    expect(screen.getByTestId('password-input')).toBeTruthy();
    expect(screen.queryByTestId('first-name-input')).toBeNull();
  });

  it('turns to sign-up in place, keeping what was typed', () => {
    raise('login');
    type('email-input', 'reader@example.com');
    fireEvent.click(screen.getByTestId('auth-switch'));
    expect(mode).toBe('register');
    expect(screen.getByTestId('sheet')).toBeTruthy();
    expect(screen.getByText('Create your account')).toBeTruthy();
    expect(screen.getByTestId('first-name-input')).toBeTruthy();
    expect((screen.getByTestId('email-input') as HTMLInputElement).value).toBe(
      'reader@example.com',
    );
  });

  it('leads with Apple, then Google, both above the email form', () => {
    raise('register');
    const apple = screen.getByTestId('auth-apple');
    const google = screen.getByTestId('auth-google');
    const firstField = screen.getByTestId('first-name-input');
    const follows = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(apple.compareDocumentPosition(google) & follows).toBeTruthy();
    expect(google.compareDocumentPosition(firstField) & follows).toBeTruthy();
    expect(screen.getByText('or continue with email')).toBeTruthy();
  });

  it.each(['Apple', 'Google'])(
    'says %s is not available yet, and signs nobody in',
    (provider) => {
      raise('login');
      fireEvent.click(screen.getByTestId(`auth-${provider.toLowerCase()}`));
      expect(
        screen.getByTestId('auth-provider-unavailable').textContent,
      ).toContain(`Sign in with ${provider} isn't available yet`);
      expect(login).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(loginAsGuest).not.toHaveBeenCalled();
      expect(mode).toBe('login');
    },
  );

  it('asks for both fields before trying', () => {
    raise('login');
    fireEvent.click(screen.getByTestId('auth-submit'));
    expect(screen.getByTestId('auth-error').textContent).toBe(
      'Enter your email and password.',
    );
    expect(login).not.toHaveBeenCalled();
  });

  it('holds a short password on sign-up', () => {
    raise('register');
    type('email-input', 'reader@example.com');
    type('password-input', 'short');
    fireEvent.click(screen.getByTestId('auth-submit'));
    expect(screen.getByTestId('auth-error').textContent).toBe(
      'Password must be at least 8 characters.',
    );
    expect(register).not.toHaveBeenCalled();
  });

  it('logs in and puts the sheet away', async () => {
    raise('login');
    type('email-input', '  reader@example.com ');
    type('password-input', 'hunter22');
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() => expect(mode).toBeNull());
    expect(login).toHaveBeenCalledWith('reader@example.com', 'hunter22');
  });

  it('keeps the sheet up and says why when sign-in fails', async () => {
    login.mockRejectedValueOnce(new Error('Invalid email or password.'));
    raise('login');
    type('email-input', 'reader@example.com');
    type('password-input', 'wrong-one');
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('auth-error').textContent).toBe(
        'Invalid email or password.',
      ),
    );
    expect(mode).toBe('login');
  });

  it('continues as a guest and puts the sheet away', async () => {
    raise('login');
    fireEvent.click(screen.getByTestId('auth-guest'));
    await waitFor(() => expect(mode).toBeNull());
    expect(loginAsGuest).toHaveBeenCalledTimes(1);
  });

  it('closes from its own close control', () => {
    raise('login');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(mode).toBeNull();
  });
});
