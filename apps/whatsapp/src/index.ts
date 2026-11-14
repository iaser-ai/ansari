/**
 * apps/whatsapp: the runnable service. Wires the pieces together and listens.
 *
 * Python counterpart: the module-level code and the `if __name__ == "__main__"` block of `app/main.py`.
 *
 * Start it with `pnpm --filter ansari-whatsapp dev` (restarts on change) or `start` (runs the built file).
 */
import 'dotenv/config';
import { BackgroundTasks } from './background';
import { buildApp } from './app';
import { getEnv } from './config';
import { ConversationManager } from './conversationManager';
import { createLogger } from './logger';
import { flushSentry, initSentry, sentryReporter } from './sentry';
import { createServices } from './services/createServices';
import { gracefulShutdown } from './server';

/** Railway waits about this long after SIGTERM before it kills the process. */
const SHUTDOWN_GRACE_MS = 8_000;

const env = getEnv();
const logger = createLogger({
  environment: env.ENVIRONMENT,
  level: env.LOGGING_LEVEL,
  githubActions: process.env.GITHUB_ACTIONS,
});

// Sentry stays off for development, with or without a DSN
if (env.ENVIRONMENT !== 'development') initSentry(env.SENTRY_DSN, env.ENVIRONMENT);

const services = createServices(env, logger, sentryReporter);
const background = new BackgroundTasks({ logger, reportError: sentryReporter });
const manager = new ConversationManager({
  config: env,
  ...services,
  logger,
  reportError: sentryReporter,
});
const app = buildApp({ config: env, manager, background, logger, reportError: sentryReporter });

// Python: "localhost" when developing (not reachable from other machines), every interface when deployed (a container's
// platform proxy reaches it from outside).
const host = env.ENVIRONMENT === 'development' ? 'localhost' : '0.0.0.0';
const server = app.listen(env.PORT, host, () => {
  logger.info(`WhatsApp service (${env.ENVIRONMENT}) listening on ${host}:${env.PORT}`);
});

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info(`Received ${signal}`);
  void gracefulShutdown({ server, background, logger, graceMs: SHUTDOWN_GRACE_MS, flush: () => flushSentry(2_000) }).then(
    () => process.exit(0),
  );
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

// A fault nobody caught anywhere else: say so, tell the operator, and carry on (the tasks have their own catch, so this is
// for bugs in code that runs outside them)
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
  sentryReporter(reason, { errorType: 'unhandled_rejection' });
});
