/**
 * The Express app: the three routes Meta and the platform call, built without listening so tests can drive it.
 *
 * Python counterpart: `app/main.py` (FastAPI). The checks that used to sit in its webhook route (maintenance, the staging
 * `!d ` filter, message age, message type) moved to `ConversationManager.triage`; this file only turns each answer into the
 * HTTP reply Meta gets.
 *
 *   GET  /            health probe
 *   GET  /whatsapp/v3 Meta's one-time handshake when the callback URL is saved in its dashboard
 *   POST /whatsapp/v3 every message and delivery receipt
 *
 * The routes are `/whatsapp/v3` where the Python service served `/whatsapp/v2`: the two services share one Meta callback URL
 * at a time, so the version in the path says which of them Meta is talking to.
 *
 * What a POST goes through:
 *   read the raw bytes  ->  check the signature  ->  parse the JSON  ->  work out what it is  ->  answer Meta  ->  (afterwards)
 *   sign in, ask apps/api and reply to the user
 *
 * Differences from Python:
 * - The body is read as raw bytes and parsed by hand, after the signature check. `express.json()` would parse (and reject bad
 *   JSON with a 400) before the signature is looked at, so an unsigned caller could tell valid JSON from invalid. FastAPI
 *   checked the signature in a dependency that ran first; this keeps that order.
 * - CORS is the `cors` package, not Starlette's. A request from an origin that is not allowed is still handled, as in Python,
 *   but a preflight from one gets no CORS headers (Python answered it with a 400). Meta's servers send no `Origin` header at all.
 * - There is no 405 for a wrong method on a known path: Express answers 404, as it does for any route it does not have.
 * - An error that escapes a route is reported and answered with a 500, as before; Express 5 passes the failure of an `async`
 *   handler to the error handler by itself, so no wrapper is needed.
 */
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { BackgroundTasks } from './background';
import type { Env } from './config';
import type { ConversationManager, TriageAction } from './conversationManager';
import type { ErrorReporter } from './errorReporter';
import { noopErrorReporter } from './errorReporter';
import { InvalidMetaPayloadError, UnexpectedMetaPayloadError } from './errors';
import { getRequestId, runWithRequestId, type Logger } from './logger';
import { createResponseForMeta, type MetaResponseInput } from './webhook/metaResponse';
import { parseMetaPayload } from './webhook/parseWebhook';
import { constantTimeEquals, isValidSignature } from './webhook/signature';

/** Python served `/whatsapp/v2`; see the file header for why this is `v3`. */
export const WEBHOOK_PATH = '/whatsapp/v3';

/** Meta's webhook bodies are a few kilobytes. A larger one is refused before anyone is asked to sign it. */
const BODY_LIMIT = '1mb';

const UNEXPECTED_FORMAT_NOTICE =
  'It seems Meta sent your message in an unexpected format. This is not a problem in what you wrote, ' +
  'so please send this chat as screenshot to the developers to investigate further';

/** How Meta is answered for each thing `triage` can decide (Python's status codes and `error_code`s). */
const TRIAGE_REPLIES: Record<TriageAction, MetaResponseInput> = {
  maintenance: { success: false, message: 'Service under maintenance', statusCode: 503, errorCode: 'MAINTENANCE_MODE' },
  dev_filter: {
    success: false,
    message: 'Message filtered for local development',
    statusCode: 202,
    errorCode: 'DEV_FILTER',
  },
  too_old: { success: false, message: 'Message too old, ignored', statusCode: 422, errorCode: 'MESSAGE_TOO_OLD' },
  unsupported: {
    success: false,
    message: 'Unsupported message type handled',
    statusCode: 415,
    errorCode: 'UNSUPPORTED_MESSAGE_TYPE',
  },
  text: { success: true, message: 'Message processed successfully' },
};

/** Query values arrive as a string, a list (`?a=1&a=2`) or nothing; the last one wins, as in Starlette. */
function queryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return queryValue(value[value.length - 1]);
  return undefined;
}

export function buildApp({
  config,
  manager,
  background,
  logger,
  reportError = noopErrorReporter,
}: {
  /** Just the settings the app reads: `Pick` takes those fields of the full `Env` type. */
  config: Pick<
    Env,
    | 'META_ANSARI_APP_SECRET'
    | 'META_WEBHOOK_VERIFY_TOKEN'
    | 'META_BUSINESS_PHONE_NUMBER_ID'
    | 'META_REPLY_BY_PHONE'
    | 'ALWAYS_RETURN_OK_TO_META'
    | 'ENVIRONMENT'
    | 'ORIGINS'
  >;
  /** Just the three methods the routes call. */
  manager: Pick<ConversationManager, 'triage' | 'dispatch' | 'notify'>;
  background: BackgroundTasks;
  logger: Logger;
  /** Where unexpected faults are reported; nothing is reported when left out. */
  reportError?: ErrorReporter;
}): Express {
  const app = express();
  app.disable('x-powered-by');

  /** Meta's reply is built from one place so the "always 200" rule cannot be forgotten on one path. */
  function answerMeta(res: Response, input: MetaResponseInput): void {
    const { status, body } = createResponseForMeta(input, config.ALWAYS_RETURN_OK_TO_META);
    res.status(status).json(body);
  }

  function report(error: unknown, errorType: string): void {
    // Only the request id travels with the event, never a BSUID, phone number, token or message text
    reportError(error, { errorType, context: { request_id: getRequestId() } });
  }

  // A fresh id per request, on every log line it causes (Python: `request_id_var`) and on the response, so one message can
  // be followed through the logs. The caller's own `X-Request-ID` is ignored: it is untrusted text going into the logs.
  app.use((_req, res, next) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    runWithRequestId(requestId, () => {
      logger.debug('Request started');
      res.once('finish', () => logger.debug('Request ended'));
      next();
    });
  });

  const allowedOrigins = new Set(config.ORIGINS);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin !== undefined && !allowedOrigins.has(origin)) {
          logger.error(`CORS Origin Error: ${origin} is not one of the allowed origins ${JSON.stringify(config.ORIGINS)}`);
        }
        callback(null, origin !== undefined && allowedOrigins.has(origin) ? origin : false);
      },
      credentials: true,
    }),
  );

  app.get('/', (_req, res) => {
    logger.info('Health check endpoint called');
    res.json({ status: 'ok', message: 'Ansari WhatsApp service is running' });
  });

  // Crashes on purpose, to prove errors reach Sentry. Open to anyone who finds it, so never in production.
  if (config.ENVIRONMENT !== 'production') {
    app.get('/sentry-debug', () => {
      throw new Error('Deliberate error to test Sentry (GET /sentry-debug)');
    });
  }

  /**
   * Meta's verification handshake: when the callback URL is saved in the dashboard, Meta sends `hub.mode=subscribe`, our
   * verify token and a random `hub.challenge`, and expects the challenge back.
   * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
   */
  app.get(WEBHOOK_PATH, (req, res) => {
    const mode = queryValue(req.query['hub.mode']);
    const verifyToken = queryValue(req.query['hub.verify_token']);
    const challenge = queryValue(req.query['hub.challenge']);

    logger.debug(`Verification webhook received: mode=${mode ?? 'none'}, token_present=${Boolean(verifyToken)}`);

    if (!mode || !verifyToken) {
      res.status(400).json({ detail: 'Bad Request' });
      return;
    }
    if (mode === 'subscribe' && constantTimeEquals(config.META_WEBHOOK_VERIFY_TOKEN.reveal(), verifyToken)) {
      logger.info('WHATSAPP WEBHOOK VERIFIED SUCCESSFULLY!');
      // Sent as HTML, as Meta's own sample does and as the Python service did. Only reached once the secret token matched, so
      // nobody but Meta (or the operator) can make this service echo text into a page.
      res.status(200).type('html').send(challenge ?? '');
      return;
    }
    logger.error('Verification failed: Invalid token or mode');
    res.status(403).json({ detail: 'Forbidden' });
  });

  app.post(WEBHOOK_PATH, express.raw({ type: () => true, limit: BODY_LIMIT }), (req: Request, res: Response) => {
    // `req.body` is a Buffer once the raw parser ran, and undefined when the request carried no body at all
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // ---- 1. Is it from Meta? (403) ----
    const signatureHeader = req.get('X-Hub-Signature-256');
    if (!isValidSignature(rawBody, signatureHeader, config.META_ANSARI_APP_SECRET)) {
      if (!signatureHeader?.startsWith('sha256=')) {
        logger.warn('Missing or invalid X-Hub-Signature-256 header format');
        logger.error('Webhook signature verification failed - rejecting request');
      } else {
        logger.error("Invalid webhook signature; request isn't from Meta or you have misconfigured META_ANSARI_APP_SECRET");
      }
      res.setHeader('WWW-Authenticate', 'HMAC-SHA256').status(403).json({ detail: 'Invalid signature' });
      return;
    }
    logger.debug('Webhook signature verified successfully');

    // ---- 2. Read the JSON ----
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    } catch {
      // Not the parser's own message: a JSON syntax error quotes the start of the body, which is the user's text
      logger.error('Webhook body is not valid JSON');
      report(new Error('Webhook body is not valid JSON'), 'webhook_processing_failure');
      answerMeta(res, {
        success: false,
        message: 'Error processing webhook payload',
        statusCode: 400,
        errorCode: 'INVALID_PAYLOAD',
        details: { error: 'Webhook body is not valid JSON' },
      });
      return;
    }

    // ---- 3. What is it? ----
    let parsed;
    try {
      parsed = parseMetaPayload(payload, config, logger);
    } catch (error) {
      if (error instanceof UnexpectedMetaPayloadError) {
        logger.error(`Unexpected Meta payload format: ${error.message}`);
        report(error, 'unexpected_meta_payload');
        // One number feeds three environments, and an unreadable message has no prefix to route by, so only production notifies
        const { replyTo } = error;
        if (config.ENVIRONMENT === 'production' && replyTo) {
          background.run(() => manager.notify(replyTo, UNEXPECTED_FORMAT_NOTICE));
        } else if (!replyTo) {
          logger.error('No phone number or BSUID in the payload, so the user could not be notified');
        }
        answerMeta(res, {
          success: false,
          message: 'Unexpected message format received from Meta',
          statusCode: 400,
          errorCode: 'UNEXPECTED_PAYLOAD_FORMAT',
          details: { error: error.message },
        });
        return;
      }
      logger.error('Error extracting message details', error);
      report(error, 'webhook_processing_failure');
      answerMeta(res, {
        success: false,
        message: 'Error processing webhook payload',
        statusCode: 400,
        errorCode: 'INVALID_PAYLOAD',
        // The parser's own errors carry the payload with every value masked; anything else might not
        details: { error: error instanceof InvalidMetaPayloadError ? error.message : 'Unexpected error reading the payload' },
      });
      return;
    }

    if (parsed.kind === 'other_number') {
      logger.debug('Ignoring webhook not intended for our WhatsApp business number');
      answerMeta(res, {
        message: 'Skipping, as this webhook is not intended for our WhatsApp business number',
        statusCode: 200,
      });
      return;
    }
    if (parsed.kind === 'status') {
      logger.debug('Ignoring status update message (e.g., delivered, read)');
      answerMeta(res, { message: 'Status message processed (ignored)', errorCode: 'STATUS_MESSAGE' });
      return;
    }

    // ---- 4. What should be done with the message? Answer Meta first, do it afterwards ----
    const action = manager.triage(parsed);
    answerMeta(res, TRIAGE_REPLIES[action]);
    // Signing in and asking apps/api can take long enough for Meta to resend the message, and nothing here detects a resend
    background.run(() => manager.dispatch(parsed, action));
  });

  app.use((_req, res) => {
    res.status(404).json({ detail: 'Not Found' });
  });

  // Express recognises an error handler by its four parameters, so `_next` must stay even though it is not used
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = httpStatusOf(error);
    if (status >= 500) {
      logger.error('Unhandled exception', error);
      report(error, 'unhandled_exception');
    } else {
      logger.error(`HTTP exception: ${status}`);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    // Never the error's own text: it can quote part of the request
    res.status(status).json({ detail: status >= 500 ? 'Internal server error' : (STATUS_TEXT[status] ?? 'Bad Request') });
  });

  return app;
}

/** The status an error from the body parser carries (413 too large, 400 aborted, 415 unsupported encoding); 500 for any other. */
function httpStatusOf(error: unknown): number {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
};
