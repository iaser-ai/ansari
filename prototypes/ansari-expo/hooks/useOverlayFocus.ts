import { useEffect, useId, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * The focus lifecycle every overlay owes a keyboard.
 *
 * A sheet, a dialog, the sources panel and the phone drawer are all the
 * same promise from a keyboard's point of view: while this is open, it
 * is the only thing on the page. Four things have to be true for that
 * promise to hold, and an overlay that keeps three of them is still
 * broken —
 *
 *   1. focus moves *into* the overlay when it opens, so the next Tab is
 *      inside it rather than back at the top of the document;
 *   2. Tab and Shift-Tab cycle within it, so a reader cannot walk out
 *      into a page they can no longer see;
 *   3. Escape closes it, because that is the one key everyone tries;
 *   4. focus goes back to whatever opened it, so a reader who tabbed to
 *      a footnote and opened its source lands back on that footnote.
 *
 * All of it is web-only. On a phone the platform does this itself: a
 * native modal is a separate window, `accessibilityViewIsModal` seals
 * iOS off from what is underneath, and Android's back button is the
 * Escape key. There is no keyboard to trap.
 *
 * Usage is one line: the hook returns the DOM id to hang on the
 * overlay's own box, and `undefined` on native.
 *
 *     const overlayID = useOverlayFocus(open, onClose);
 *     <View nativeID={overlayID}>…</View>
 *
 * Two overlays can be open at once — the sources panel with the action
 * sheet over it — so the hook keeps a stack of the open ones and only
 * the topmost answers a key. Without that, a document-level listener
 * registered first (the *outer* overlay) would swallow the Escape meant
 * for the one actually on top.
 */

/** Everything a browser will let a Tab land on. */
const FOCUSABLE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Open overlays, oldest first. Only the last one listens. */
const stack: string[] = [];

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) =>
      !node.hasAttribute('disabled') &&
      node.getAttribute('aria-hidden') !== 'true' &&
      // Laid out, rather than a layer that is still in the tree only
      // because it has not finished fading.
      (node.offsetWidth > 0 || node.offsetHeight > 0),
  );
}

export function useOverlayFocus(
  open: boolean,
  onClose: () => void,
): string | undefined {
  const key = useId();
  const id =
    Platform.OS === 'web'
      ? `ansari-overlay-${key.replace(/[^a-zA-Z0-9_-]/g, '')}`
      : undefined;

  // Read at the moment a key is pressed rather than captured when the
  // overlay opened, so an `onClose` rebuilt on every render does not
  // tear the listener down and put it back on each one.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!id || !open || typeof document === 'undefined') return;

    const returnTo = document.activeElement as HTMLElement | null;
    stack.push(id);

    const container = () => document.getElementById(id);
    const onTop = () => stack[stack.length - 1] === id;

    // Two frames, not one. The overlay is mounted by the same state
    // change this effect is answering — and a sheet mounts its own
    // modal a render later still — so the first frame can arrive before
    // there is anything in the document to focus.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const box = container();
        if (!box) return;
        const first = focusables(box)[0];
        if (first) {
          first.focus();
          return;
        }
        // Nothing to land on — a sheet of plain text. The box itself
        // takes the focus so the reader is at least inside it, and the
        // trap below has something to hold.
        box.tabIndex = -1;
        box.focus();
      });
    });

    const onKey = (event: KeyboardEvent) => {
      if (!onTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const box = container();
      if (!box) return;
      const items = focusables(box);
      if (items.length === 0) {
        // Nowhere to go inside, and out is not an option.
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && box.contains(active);

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Captured, so a control inside the overlay that stops the event
    // for its own reasons cannot also stop Escape from closing it.
    document.addEventListener('keydown', onKey, true);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true);
      const at = stack.lastIndexOf(id);
      if (at !== -1) stack.splice(at, 1);
      // Only if it is still on the page: the control that opened a
      // sheet is sometimes inside the thing the sheet just changed.
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [id, open]);

  return id;
}
