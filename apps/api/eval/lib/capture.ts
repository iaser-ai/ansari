/**
 * Attributing the facilitator's own log lines to the request that wrote them.
 *
 * The facilitator reports an empty-final retry, a transient-error retry, a repetition cut
 * and a budget short-circuit only through console.warn / console.error. Those are what
 * "degraded outcomes" are made of, and with several requests in flight a shared console
 * cannot say whose line is whose. AsyncLocalStorage can: each request runs inside its own
 * store, and a line written anywhere in that request's async work lands in that store.
 *
 * Only the first argument's text and the message of any Error argument are kept, cut to
 * a fixed length: a log line is a label, not a place for content.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogEvent } from './types';

const store = new AsyncLocalStorage<LogEvent[]>();
const MAX_MESSAGE = 300;
let installed = false;

function render(args: unknown[]): string {
  const parts = args
    .filter((a) => typeof a === 'string' || a instanceof Error)
    .map((a) => (a instanceof Error ? a.message : (a as string)));
  return parts.join(' ').slice(0, MAX_MESSAGE);
}

/**
 * Route console.warn and console.error into the active request's store. Outside a
 * request they print as before. With `echo`, captured lines are printed too.
 */
export function installLogCapture(options: { echo?: boolean } = {}): void {
  if (installed) return;
  installed = true;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const events = store.getStore();
      if (!events) return original(...args);
      events.push({ level, message: render(args) });
      if (options.echo) original(...args);
    };
  }
}

/** Run `work`, returning its result and the log lines written while it ran. */
export async function withLogCapture<T>(work: () => Promise<T>): Promise<{ result: T; log: LogEvent[] }> {
  const log: LogEvent[] = [];
  const result = await store.run(log, work);
  return { result, log };
}
