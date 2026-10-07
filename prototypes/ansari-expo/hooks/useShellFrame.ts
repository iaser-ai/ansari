import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { onShellResize } from '@/hooks/useKeyboard';

export type ShellFrame = { top: number; height: number };

const readShell = (): ShellFrame => {
  const rect = document.body.getBoundingClientRect();
  return { top: rect.top, height: rect.height };
};

/**
 * The rectangle the app's shell occupies on the web, kept current.
 *
 * The shell — `body`, fixed and `100dvh` tall — is the part of the
 * window a reader can actually see: it stops above a phone browser's
 * toolbar, and while a field has focus it is shortened to the room left
 * above the keyboard (see `hooks/useKeyboard.web.ts`). A `Modal` on the
 * web knows none of this. react-native-web portals it into its own
 * fixed layer the size of the *layout* viewport, so a sheet anchored to
 * that layer's foot sits under the toolbar, and stays where it was when
 * the keyboard rises over it.
 *
 * A sheet that holds fields stands in this rectangle instead. `null`
 * on native — the keyboard controller lifts the card there — and while
 * `enabled` is off.
 */
export function useShellFrame(enabled: boolean): ShellFrame | null {
  const active = enabled && Platform.OS === 'web';
  const [frame, setFrame] = useState<ShellFrame | null>(null);

  useEffect(() => {
    if (!active) {
      setFrame(null);
      return;
    }
    const update = () => {
      const next = readShell();
      setFrame((prev) =>
        prev && prev.top === next.top && prev.height === next.height
          ? prev
          : next,
      );
    };
    update();
    // The keyboard reshape is announced; the browser's own chrome
    // growing and shrinking (`100dvh`) arrives as a viewport resize; and
    // the shell eases back to full height after the keyboard leaves, so
    // its last frame is read when that transition ends.
    const offShell = onShellResize(update);
    const viewport = window.visualViewport;
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    document.body.addEventListener('transitionend', update);
    return () => {
      offShell();
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      document.body.removeEventListener('transitionend', update);
    };
  }, [active]);

  return frame;
}
