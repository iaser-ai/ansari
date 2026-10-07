// @vitest-environment jsdom
/**
 * The shell's rectangle, as a sheet that holds fields stands in it
 * (issue #245). jsdom lays nothing out, so the shell's rect is stubbed
 * and what is held to account is when the hook reads it: on mount, on a
 * keyboard reshape, on a viewport resize, and when the shell's eased
 * return finishes — and never at all while it is switched off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const shellListeners = new Set<() => void>();
vi.mock('@/hooks/useKeyboard', () => ({
  onShellResize: (listener: () => void) => {
    shellListeners.add(listener);
    return () => shellListeners.delete(listener);
  },
}));

import { useShellFrame } from '@/hooks/useShellFrame';

let rect = { top: 0, height: 844 };

beforeEach(() => {
  rect = { top: 0, height: 844 };
  vi.spyOn(document.body, 'getBoundingClientRect').mockImplementation(
    () => ({ top: rect.top, height: rect.height }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  shellListeners.clear();
});

const reshape = (next: { top: number; height: number }, fire: () => void) => {
  rect = next;
  act(fire);
};

describe('useShellFrame (issue #245)', () => {
  it('is null while switched off, and does not listen', () => {
    const { result } = renderHook(() => useShellFrame(false));
    expect(result.current).toBeNull();
    expect(shellListeners.size).toBe(0);
  });

  it("reads the shell's rect on mount", () => {
    const { result } = renderHook(() => useShellFrame(true));
    expect(result.current).toEqual({ top: 0, height: 844 });
  });

  it('follows a keyboard reshape announced by the shell', () => {
    const { result } = renderHook(() => useShellFrame(true));
    reshape({ top: 0, height: 391 }, () =>
      shellListeners.forEach((listener) => listener()),
    );
    expect(result.current).toEqual({ top: 0, height: 391 });
  });

  it("follows the browser's own chrome through a viewport resize", () => {
    const { result } = renderHook(() => useShellFrame(true));
    reshape({ top: 0, height: 760 }, () =>
      window.dispatchEvent(new Event('resize')),
    );
    expect(result.current).toEqual({ top: 0, height: 760 });
  });

  it("reads the shell's last frame when its eased return ends", () => {
    const { result } = renderHook(() => useShellFrame(true));
    reshape({ top: 0, height: 391 }, () =>
      shellListeners.forEach((listener) => listener()),
    );
    reshape({ top: 0, height: 844 }, () =>
      document.body.dispatchEvent(new Event('transitionend')),
    );
    expect(result.current).toEqual({ top: 0, height: 844 });
  });

  it('keeps the same object when nothing moved, so the sheet does not re-render', () => {
    const { result } = renderHook(() => useShellFrame(true));
    const first = result.current;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(result.current).toBe(first);
  });

  it('stops listening when switched off, and lets go of the frame', () => {
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useShellFrame(on),
      { initialProps: { on: true } },
    );
    expect(shellListeners.size).toBe(1);
    rerender({ on: false });
    expect(shellListeners.size).toBe(0);
    expect(result.current).toBeNull();
  });
});
