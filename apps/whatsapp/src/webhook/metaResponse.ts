/**
 * The JSON body this service answers Meta with, and the HTTP status that goes with it.
 *
 * Python counterpart: `create_response_for_meta` in `whatsapp_webhook_utils.py`.
 *
 * Meta wants an HTTP 200 for every webhook it delivers. Any other status (or a reply that takes too long) counts as a failed
 * delivery, and Meta then resends it with growing delays for up to 24 hours, which would answer the same user several times.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview#webhook-delivery-failure
 *
 * So in real use (`ALWAYS_RETURN_OK_TO_META` true) the status is always 200 and only the body says what happened. Automated tests
 * turn the flag off to see the real status.
 */

export interface MetaResponseInput {
  success?: boolean;
  message?: string;
  /** The status to use when the flag is off and `success` is false. */
  statusCode?: number;
  /** A machine-readable reason, such as `MAINTENANCE_MODE`. */
  errorCode?: string;
  /** Goes under the `detail` key. */
  details?: Record<string, unknown>;
}

export interface MetaResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Build the status and body for one answer to Meta.
 *
 * @param alwaysOk `ALWAYS_RETURN_OK_TO_META`.
 * @param nowSeconds The current unix time; only tests pass it.
 */
export function createResponseForMeta(
  input: MetaResponseInput,
  alwaysOk: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): MetaResponse {
  const { success = true, message = 'OK', statusCode = 200, errorCode, details } = input;

  const body: Record<string, unknown> = { success, message, timestamp: nowSeconds };
  // Python's `if error_code:` and `if details:`: an empty string or an empty object is left out
  if (errorCode) body.error_code = errorCode;
  if (details && Object.keys(details).length > 0) body.detail = details;

  return { status: alwaysOk || success ? 200 : statusCode, body };
}
