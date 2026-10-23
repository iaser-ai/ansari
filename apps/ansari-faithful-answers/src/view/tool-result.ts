// App-owned mapping from an MCP tool result to the answer the shared card shows. Pure and
// browser-safe. It decides what to display; it never renders Markdown and never edits the answer.
// The definition's one `.result(...)` reader is `classifyCardResult`: the stack hands it the whole
// delivered result. This is the application's one classification contract, imported from the original
// application (upstream abd256d) and kept with its original semantics.
import type {CardResultOutcome} from '@saga-a2ui/react-mcp-stack/faithful-card';
import {readAnswerEnvelope, type AnswerEnvelope} from './envelope.js';

export const UNSUPPORTED_RESULT_TEXT = 'This result could not be displayed.';

/** The structural subset of an MCP tool result the view reads. */
export type ToolResultLike = {
  structuredContent?: unknown;
  content?: ReadonlyArray<{type?: string; text?: string}>;
  isError?: boolean;
};

export type ClassifiedResult =
  | {kind: 'valid'; envelope: AnswerEnvelope}
  | {kind: 'rejected'; text: string};

/** The FIRST text block's text, when it is a non-empty string. An empty first block is not skipped for a later one. */
function contentText(result: ToolResultLike): string | undefined {
  const text = result.content?.find(block => block.type === 'text')?.text;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

/**
 * A failed call is always a problem and shows its own (server-written, fixed) message, whatever the
 * structured content says. A successful call shows the answer from `structuredContent` when the host
 * delivered it: a structured envelope that is present but malformed is unsupported, even when text
 * content exists. Only when it is absent (or null) does the text content stand in, exactly as sent.
 */
export function classifyToolResult(result: ToolResultLike): ClassifiedResult {
  const fallback = contentText(result) ?? UNSUPPORTED_RESULT_TEXT;
  if (result.isError) return {kind: 'rejected', text: fallback};
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null) {
    const envelope = readAnswerEnvelope(structured);
    return envelope === undefined ? {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT} : {kind: 'valid', envelope};
  }
  const text = contentText(result);
  return text === undefined
    ? {kind: 'rejected', text: UNSUPPORTED_RESULT_TEXT}
    : {kind: 'valid', envelope: {question: '', answer: text}};
}

/** The same decision in the stack's terms: the answer as the card's Markdown, the question as its heading. */
export function classifyCardResult(result: ToolResultLike): CardResultOutcome {
  const classified = classifyToolResult(result);
  return classified.kind === 'valid'
    ? {kind: 'content', content: {heading: classified.envelope.question, markdown: classified.envelope.answer}}
    : {kind: 'rejected', text: classified.text};
}

