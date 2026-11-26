/**
 * Stopping the service cleanly.
 *
 * Python counterpart: none of its own (uvicorn did it). Railway stops a service by sending SIGTERM and killing it after a grace
 * period, and a deploy happens while users are mid-conversation. A message Meta has already been answered for lives only in
 * a background task, so killing the process at once would drop that user's reply with nobody left to tell them. Shutdown
 * therefore stops accepting new requests, waits (up to a limit) for the tasks already started, sends what Sentry still holds,
 * and only then lets the process end.
 */
import type { Server } from 'node:http';
import type { BackgroundTasks } from './background';
import type { Logger } from './logger';

export interface ShutdownOptions {
  server: Server;
  background: BackgroundTasks;
  logger: Logger;
  /** How long to wait for running tasks before giving up on them. Railway's own limit is shorter than a chat answer can be. */
  graceMs: number;
  /** Runs last, e.g. sending queued Sentry events. A failure here is logged, never thrown. */
  flush?: () => Promise<void>;
}

/** Stop taking requests, wait for background work, flush. Never throws. Resolves when it is safe to exit. */
export async function gracefulShutdown(options: ShutdownOptions): Promise<void> {
  const { server, background, logger, graceMs, flush } = options;
  logger.info(`Shutting down: no new requests, waiting up to ${graceMs / 1000}s for ${background.pending} running task(s)`);

  // Stop listening. Since Node 19 this also closes idle keep-alive connections, which would otherwise delay the callback.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));

  const finished = await background.idle(graceMs);
  if (!finished) logger.warn(`Gave up on ${background.pending} task(s) still running after ${graceMs / 1000}s`);

  // Anything still open now is a client that has not finished reading, and the work behind it is over
  server.closeAllConnections();
  await closed;

  if (flush) {
    try {
      await flush();
    } catch (error) {
      logger.error('Could not flush error reports before exit', error);
    }
  }
  logger.info('Shutdown complete');
}
