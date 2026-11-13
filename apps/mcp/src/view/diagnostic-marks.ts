/**
 * Milestones a card records for first-load diagnosis (#335), shared by the card and the server that accepts its reports,
 * in milliseconds since the card's document started:
 * - `script`, `main`: the early script ran; the bundle finished evaluating.
 * - `hostMessage`, `toolInput`, `toolResult`, `toolCancelled`, `teardownRequested`: the host's first JSON-RPC message, its tool
 *   input, result and cancellation notifications, and its request to tear the card down, as they arrived.
 * - `fonts`, `context`, `ready`, `failed`: the stack's readiness work, host context delivery (after the handshake
 *   and fonts), and how starting ended.
 * - `result`, `problem`: the first answer or problem the chrome rendered.
 * - `firstPaint`, `firstContentfulPaint`: the browser's paint timings.
 */
export const VIEW_MARKS = ['script', 'main', 'hostMessage', 'toolInput', 'toolResult', 'toolCancelled', 'teardownRequested', 'fonts', 'context', 'ready', 'failed', 'result', 'problem', 'firstPaint', 'firstContentfulPaint'] as const;
export type ViewMark = (typeof VIEW_MARKS)[number];

/** Why a card sent a report. */
export const VIEW_REPORT_REASONS = ['load', 'ready', 'failed', 'result', 'problem', 'pagehide', 'timeout'] as const;
export type ViewReportReason = (typeof VIEW_REPORT_REASONS)[number];
