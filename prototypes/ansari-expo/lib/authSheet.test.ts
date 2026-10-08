// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  closeAuthSheet,
  openAuthSheet,
  setAuthSheetMode,
  useAuthSheet,
} from '@/lib/authSheet';

afterEach(() => {
  act(() => closeAuthSheet());
});

describe('auth sheet store (issue #245)', () => {
  it('starts put away', () => {
    const { result } = renderHook(() => useAuthSheet());
    expect(result.current).toBeNull();
  });

  it('opens on the face it was asked for', () => {
    const { result } = renderHook(() => useAuthSheet());
    act(() => openAuthSheet('register'));
    expect(result.current).toBe('register');
  });

  it('turns to its other face without closing', () => {
    const { result } = renderHook(() => useAuthSheet());
    act(() => openAuthSheet('login'));
    act(() => setAuthSheetMode('register'));
    expect(result.current).toBe('register');
  });

  it('does not open itself when asked to turn while put away', () => {
    const { result } = renderHook(() => useAuthSheet());
    act(() => setAuthSheetMode('register'));
    expect(result.current).toBeNull();
  });

  it('closes', () => {
    const { result } = renderHook(() => useAuthSheet());
    act(() => openAuthSheet('login'));
    act(() => closeAuthSheet());
    expect(result.current).toBeNull();
  });
});
