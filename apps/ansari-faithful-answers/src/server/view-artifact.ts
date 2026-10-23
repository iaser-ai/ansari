import {operationViewFromHtml, type OperationView} from '@saga-a2ui/react-mcp-stack/server';
import {stampHtmlRevision} from './operation-log.js';

/** The file name the view's content identity keeps: `ui://views/answer-card.<fingerprint>.html`. */
export const VIEW_FILENAME = 'answer-card.html';

/** Prepare immutable deployment bytes once from the built card the host supplies: no file is read here. */
export function prepareAnswerView(html: string, release?: string): OperationView {
  const currentHtml = stampHtmlRevision(html, release);
  // The identity is taken from the final bytes, after revision stamping. Declared permissions stay closed.
  return Object.freeze(operationViewFromHtml({html: currentHtml, filename: VIEW_FILENAME, title: 'Ansari answer card'}));
}
