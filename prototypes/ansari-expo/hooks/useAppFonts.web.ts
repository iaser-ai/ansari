/**
 * Ansari's type on the web: already the browser's problem.
 *
 * `public/index.html` declares every face as a real `@font-face` and
 * preloads the ones a first screen needs, so the browser is holding
 * them before it paints any text — which is both faster than the
 * runtime loader and the only way to be sure nothing is ever painted in
 * a substitute face.
 *
 * So the web is always ready, and nothing is withheld: the app renders
 * on the first frame it can rather than waiting on thirteen font files.
 * This module also keeps those thirteen TTFs — close to four megabytes
 * of unsubsetted desktop fonts — out of the web bundle entirely, which
 * is why the split is a platform *file* rather than a branch inside
 * one.
 */
export function useAppFonts(): boolean {
  return true;
}
