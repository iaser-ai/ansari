/**
 * Work that runs after Meta has been answered.
 *
 * Python counterpart: FastAPI's `BackgroundTasks`. Meta wants its HTTP 200 quickly, but signing in and asking apps/api can take
 * a minute, so the route replies first and starts the work afterwards.
 *
 * A promise nobody awaits fails silently in JavaScript: its error goes nowhere (and in Node an unhandled rejection can even end
 * the process). Every task therefore runs inside `run()`, the single place that catches, logs and reports what escapes it. The
 * tasks are also counted so a shutdown can wait for the answers still being prepared (`idle`).
 */
import type { ErrorReporter } from './errorReporter';
import { noopErrorReporter } from './errorReporter';
import { getRequestId, type Logger } from './logger';

export class BackgroundTasks {
  readonly #running = new Set<Promise<void>>();
  readonly #logger: Logger;
  readonly #reportError: ErrorReporter;

  constructor(options: { logger: Logger; reportError?: ErrorReporter }) {
    this.#logger = options.logger;
    this.#reportError = options.reportError ?? noopErrorReporter;
  }

  /** How many tasks have started and not yet finished. */
  get pending(): number {
    return this.#running.size;
  }

  /**
   * Start `task` after the current code has finished, so the route's reply is already on its way. Never throws, and neither
   * does the promise it starts.
   *
   * The task writes its log lines under the request id of the request that started it without any help from here: the id lives
   * in an `AsyncLocalStorage`, which follows every promise continuation created inside the request.
   */
  run(task: () => Promise<void>): void {
    const requestId = getRequestId();
    const tracked: Promise<void> = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        // Only the request id travels with the report: never a BSUID, phone number, token or message text
        this.#logger.error('Unhandled error in background processing', error);
        this.#reportError(error, { errorType: 'background_processing_failure', context: { request_id: requestId } });
      })
      .finally(() => {
        this.#running.delete(tracked);
      });
    this.#running.add(tracked);
  }

  /**
   * Wait until no task is running, or `timeoutMs` has passed.
   *
   * @returns `true` if everything finished in time, `false` if some task was still running when the wait ended.
   */
  async idle(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      // A finished task can start another (none does today), so look again after each wait
      while (this.#running.size > 0) {
        const settled = await Promise.race([Promise.allSettled([...this.#running]).then(() => true as const), timedOut]);
        if (!settled) return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
}
