import type {CardChromeProps} from '@saga-a2ui/react-mcp-stack/faithful-card';
import {createElement, useEffect, type ComponentType} from 'react';
import type {ViewMark, ViewReportReason} from './diagnostic-marks.js';

// First-load diagnosis (#335). The early script in mcp-app-react.html owns the record and all reporting, and exists
// only in a card served with a diagnostics address. The stack's hooks (hostContext, readyWhen, onError, the `ready`
// promise and the chrome) add how far the card got, and report at its own milestones. In any other card every
// function here does nothing.

type DiagnosticRecord = {
  marks: Partial<Record<ViewMark, number>>;
  errors: Record<string, string>[];
  settled: boolean;
  host?: string;
  failure?: string;
  report: (reason: ViewReportReason) => void;
};
declare global {
  interface Window { __ansariDiag?: DiagnosticRecord }
}

const MAX_ERRORS = 20;
const diagnostic = (): DiagnosticRecord | undefined => window.__ansariDiag;

export function mark(name: ViewMark): void {
  const record = diagnostic();
  if (record) record.marks[name] ??= performance.now();
}

export function noteHost(name: string | undefined): void {
  const record = diagnostic();
  if (record && name !== undefined) record.host ??= name;
}

export function noteCallbackError(error: unknown, phase: string): void {
  const record = diagnostic();
  if (record && record.errors.length < MAX_ERRORS) record.errors.push({type: 'callback', name: error instanceof Error ? error.name : typeof error, phase});
}

/**
 * Reports once when the card has started, or failed to start. A closed card attaches nothing, so a start failure
 * still surfaces as an unhandled rejection, as it does without diagnostics.
 */
export function watchStart(ready: Promise<void>, failureKind: (failure: unknown) => string): void {
  const record = diagnostic();
  if (!record) return;
  ready.then(
    () => {
      record.settled = true;
      mark('ready');
      record.report('ready');
    },
    (error: unknown) => {
      record.settled = true;
      record.failure = failureKind(error);
      mark('failed');
      record.report('failed');
    },
  );
}

/** The application's chrome, marking the first answer and the first problem it actually rendered. */
export function observedChrome(Chrome: ComponentType<CardChromeProps>): ComponentType<CardChromeProps> {
  return function ObservedChrome(props: CardChromeProps) {
    const kind = props.state.kind;
    useEffect(() => {
      const record = diagnostic();
      if (!record || kind === 'waiting') return;
      const name = kind === 'answer' ? 'result' : 'problem';
      if (record.marks[name] !== undefined) return;
      mark(name);
      record.report(name);
    }, [kind]);
    return createElement(Chrome, props);
  };
}
