import {operationViewFromHtml, type OperationView} from '@saga-a2ui/react-mcp-stack/server';
import {stampHtmlRevision} from './operation-log.js';

/** The file name in the view's address, `ui://views/answer-card.v<major>.html`. */
export const VIEW_FILENAME = 'answer-card.html';
/**
 * The card's compatibility line. The address names it, not the card's bytes, so every compatible release keeps one address
 * and a host holding an earlier tool descriptor still reads a card that is served. Increase it only for a change an
 * already-loaded card cannot handle: a result shape or action it would misread.
 */
export const VIEW_MAJOR = 1;
/** Where a diagnostic card sends its milestone reports (#335). Served only when a diagnostics origin is configured. */
export const VIEW_DIAGNOSTICS_PATH = '/diag/view';
/** The head element that switches a card's diagnostics on; the card's early script reads it before the bundle runs. */
export const VIEW_DIAGNOSTICS_META = 'ansari-diagnostics';
const CLOSED_CONNECT = "connect-src 'none'";

/**
 * Prepare immutable deployment bytes once from the built card the host supplies: no file is read here.
 * With a diagnostics origin (a deployment under diagnosis), the card may connect to that one origin and is told
 * where to report. That changes its bytes and its permissions, not its address, so a diagnostic run is compared with
 * the closed card, not assumed equal to it. Without one, the card and its permissions are exactly the built card's.
 */
export function prepareAnswerView(html: string, release?: string, diagnosticsOrigin?: string): OperationView {
  let currentHtml = stampHtmlRevision(html, release);
  if (diagnosticsOrigin !== undefined) {
    if (!currentHtml.includes(CLOSED_CONNECT)) throw new Error(`The card has no "${CLOSED_CONNECT}" rule to open for diagnostics.`);
    if (!/<head[^>]*>/.test(currentHtml)) throw new Error('The card has no <head> to carry its diagnostics address.');
    currentHtml = currentHtml
      .replace(CLOSED_CONNECT, `connect-src ${diagnosticsOrigin}`)
      .replace(/<head[^>]*>/, head => `${head}<meta name="${VIEW_DIAGNOSTICS_META}" content="${diagnosticsOrigin}${VIEW_DIAGNOSTICS_PATH}">`);
    return Object.freeze(operationViewFromHtml({html: currentHtml, filename: VIEW_FILENAME, major: VIEW_MAJOR, title: 'Ansari answer card', csp: {connectDomains: [diagnosticsOrigin]}}));
  }
  // The release stamp is in the bytes, not the address. Declared permissions stay closed.
  return Object.freeze(operationViewFromHtml({html: currentHtml, filename: VIEW_FILENAME, major: VIEW_MAJOR, title: 'Ansari answer card'}));
}
