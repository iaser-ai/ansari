export type OperationRecord = {
  event: string;
  method?: string;
  requestId?: string | number | null;
  [key: string]: unknown;
};

export type OperationLogger = (record: OperationRecord) => void;

const FORBIDDEN = new Set([
  'question',
  'answer',
  'authorization',
  'session',
  'sessionId',
  'token',
  'messages',
  'params',
  'body',
]);

export const SAFE_REVISION = /^[A-Za-z0-9._+-]{1,80}$/;

import {APP_VERSION} from '../version.js';
export const DEFAULT_RELEASE = APP_VERSION;

export function stampHtmlRevision(html: string, revision: string = DEFAULT_RELEASE): string {
  const safe = SAFE_REVISION.test(revision) ? revision : DEFAULT_RELEASE;
  if (/data-revision=/.test(html)) {
    return html.replace(/data-revision="[^"]*"/, `data-revision="${safe}"`);
  }
  return html.replace(/<body([^>]*)>/, `<body$1 data-revision="${safe}">`);
}

/** Records go to an explicit logger and release: standard output under Node, the console under Workers. */
export function writeOperationLog(
  record: OperationRecord,
  logger: OperationLogger,
  release: string = DEFAULT_RELEASE,
): void {
  const payload: OperationRecord = { release, ...record };
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN.has(key)) {
      delete payload[key];
    }
  }
  logger(payload);
}
