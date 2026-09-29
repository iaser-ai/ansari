import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Saying something out loud that is not written anywhere a reader can
 * be pointed at.
 *
 * Almost everything the app tells a screen reader is a label on
 * something: a button, a row, a heading. A few things are not. An
 * answer arriving is the important one — the page changes underneath a
 * reader who is not looking at it, and nothing about that change is
 * focused, so unless it is announced they are left listening to
 * silence with the reply already on the page.
 *
 * `AccessibilityInfo.announceForAccessibility` is the platform call for
 * this, and on the web it does nothing at all — react-native-web
 * implements it as an empty function, because a browser has no such
 * API. A browser's equivalent is a live region: an element that was
 * already in the document, into which text is inserted. So this owns
 * one, appended once, off screen, and writes into it.
 *
 * Polite, never assertive: an answer arriving is worth saying, and it
 * is not worth cutting off whatever the reader is in the middle of.
 */

/** The live region's id, so a hot reload reuses the one already there. */
const REGION_ID = 'ansari-live-region';

function region(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const existing = document.getElementById(REGION_ID);
  if (existing) return existing;
  const node = document.createElement('div');
  node.id = REGION_ID;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  // The same clip every visually-hidden helper uses: present, measured,
  // read — and never painted. See `OFFSCREEN` in `lib/semantics`.
  node.style.cssText =
    'position:absolute;width:1px;height:1px;margin:-1px;padding:0;' +
    'overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
  document.body.appendChild(node);
  return node;
}

export function announce(message: string) {
  if (!message) return;

  if (Platform.OS !== 'web') {
    AccessibilityInfo.announceForAccessibility(message);
    return;
  }

  const node = region();
  if (!node) return;
  // Cleared first, then filled on the next frame. A region whose text
  // is replaced with the *same* string is not a change, and the same
  // sentence twice in a row — "Answer ready" after two questions — is
  // exactly the case that matters here.
  node.textContent = '';
  requestAnimationFrame(() => {
    node.textContent = message;
  });
}
