import { useIsFocused } from '@react-navigation/native';
import { Platform } from 'react-native';

import { landmark } from '@/lib/semantics';

/**
 * The props a screen's own content puts on its outermost box, so that
 * the page a reader is on is the page assistive technology describes.
 *
 * A navigator does not unmount the screen behind the one on top: the
 * ask stays in the tree under the thread, ready to be slid back to.
 * Sighted readers never see it, and until this hook existed a screen
 * reader saw both — two `main` landmarks, two first-level headings, and
 * a whole page of suggestions and a composer sitting invisibly behind
 * an answer, all of it reachable by heading and landmark navigation.
 *
 * So `main` belongs to the focused screen alone, and the screens behind
 * it are hidden from the accessibility tree entirely, the same way they
 * are hidden from the eye. Focus is the test rather than opacity or
 * position: it is what the navigator itself means by "the page you are
 * on", and it flips at the moment the route changes rather than at the
 * end of an animation.
 */
export function useScreenLandmark() {
  const focused = useIsFocused();

  if (focused) return landmark('main');

  // Behind the current page. On a phone the platform's own navigator
  // already takes the screen underneath out of the accessibility tree;
  // on the web nothing does, and a `div` is a `div`.
  return Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : ({} as Record<string, unknown>);
}
