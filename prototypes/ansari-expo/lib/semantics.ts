import { Platform } from 'react-native';

/**
 * The structure a page has that is not visible on it.
 *
 * React Native has no document outline: a screen is a tree of views, an
 * `accessibilityRole="header"` says "this is a heading" and nothing
 * about which heading, and there is no such thing as a landmark. A
 * browser has all three, and a screen-reader user navigating a public
 * website reaches for them first — jump to the navigation, jump to the
 * main content, walk the headings to find the part of an answer they
 * want.
 *
 * So the semantics are added on the web and only on the web, through
 * the props react-native-web understands and react-native would only
 * be confused by. The helpers below are typed as plain objects and
 * spread onto a view; on a phone they spread nothing, and the platform's
 * own `accessibilityRole` carries what it can.
 */

/** What the web props are, once spread. RNW reads them; RN never sees them. */
type WebProps = Record<string, unknown>;

/**
 * A heading, with its depth.
 *
 * `role="heading"` plus `aria-level` is what react-native-web turns
 * into a real `<h1>`…`<h6>`, which is the only form a browser's
 * heading navigation can see. `accessibilityRole="header"` is kept
 * alongside it for the phone, where it is the whole vocabulary
 * available — VoiceOver and TalkBack know "heading" but not "level 3".
 *
 * Levels are clamped to 6 rather than allowed to run off the end: an
 * answer with five nested Markdown headings under a page title would
 * otherwise ask for an `<h7>`, which does not exist.
 */
export function heading(level: number): WebProps {
  const depth = Math.min(6, Math.max(1, Math.round(level)));
  return Platform.OS === 'web'
    ? { role: 'heading', 'aria-level': depth }
    : { accessibilityRole: 'header' };
}

/**
 * A landmark region — the parts of the page assistive technology can
 * jump between without reading everything in between.
 *
 * `navigation` is the rail, wherever it is standing; `main` is what the
 * screen is actually about, and there is exactly one of them on screen
 * at a time because the rail and the chrome live outside every screen's
 * own subtree (see `AppFrame`).
 */
export function landmark(
  kind: 'navigation' | 'main' | 'contentinfo',
  label?: string,
): WebProps {
  if (Platform.OS !== 'web') return {};
  return label ? { role: kind, 'aria-label': label } : { role: kind };
}

/**
 * Text that is there for a screen reader and for nothing else.
 *
 * Not `display: none` and not zero-sized — either would take it out of
 * the accessibility tree along with the layout. The classic clip: one
 * pixel, out of the flow, with its own painting clipped away, which
 * every screen reader still reads and no sighted reader ever sees.
 */
export const OFFSCREEN = Platform.select({
  web: {
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  } as object,
  default: {},
});

/**
 * The id prefix a text field wears when it answers focus in its own
 * material rather than with the app's ring.
 *
 * The page stylesheet draws one focus ring on everything the browser
 * considers focusable. Two fields would rather not have it — the search
 * field inks the rim it already wears, and the composer's whole bar
 * lifts — and the way they say so is by name, one field at a time,
 * through this prefix. The rule it drives lives in `WebManners`.
 *
 * The point of naming them rather than exempting `input` and `textarea`
 * wholesale: a field added later, with no focus treatment of its own,
 * inherits the ring instead of inheriting nothing.
 */
export const SELF_INKED_FOCUS = 'ansari-inks-its-own-focus';

/**
 * A DOM id in that family, unique per mounted field. The key is
 * whatever React's `useId` gave the component; its punctuation is
 * stripped so the value stays a plain HTML id.
 */
export function selfInkedFocusId(key: string): string | undefined {
  if (Platform.OS !== 'web') return undefined;
  return `${SELF_INKED_FOCUS}-${key.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
