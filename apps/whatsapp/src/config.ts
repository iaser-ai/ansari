/**
 * Configuration for the WhatsApp service.
 *
 * Python counterpart: `legacy/whatsapp/src/ansari_whatsapp/utils/config.py`
 * (Pydantic `BaseSettings`). Every variable keeps its Python name, so the values
 * already set on Railway work unchanged.
 *
 * IMPORTANT: `.env.example` explains each setting (what it is for, allowed values,
 * default, which environments use it). Keep the two in step.
 *
 * How this differs from Pydantic Settings:
 * - Everything in `process.env` is a STRING. Pydantic turns "False" into `False`;
 *   here `"False"` would be a truthy string, so booleans go through `envBoolean`.
 * - Nothing reads `.env` automatically. `index.ts` loads it once with `dotenv`
 *   (real environment variables win over the file, as in Pydantic).
 * - Nothing validates by itself: `buildConfig()` runs the schema and throws a
 *   readable error naming each bad variable.
 */
import { z } from 'zod';

/** Mocks answer with canned data, so only `ENVIRONMENT=development` may switch them on. */
export const MOCK_FLAGS = ['MOCK_ANSARI_CLIENT', 'MOCK_AUTH_CLIENT', 'MOCK_META_API'] as const;

/**
 * A True/False switch, with the same spellings as apps/api's `MAINTENANCE_MODE`:
 * true, false, True, False, 1, 0. Anything else ("yes", "TRUE", "") stops start-up
 * instead of being guessed. `fallback` is the value when the variable is unset.
 *
 * Pydantic also accepted yes/no/on/off; check Railway's values use the spellings above.
 */
const envBoolean = (fallback: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false', 'True', 'False', '1', '0'])
    .default(fallback)
    .transform((v) => v.toLowerCase() === 'true' || v === '1');

/**
 * A secret value that never prints.
 *
 * Python counterpart: Pydantic's `SecretStr`. `String(secret)`, `JSON.stringify(secret)`,
 * template strings and `console.log(secret)` all show `**********`. Call `.reveal()` at
 * the single place that really needs the value (an `Authorization` header, an HMAC key).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '**********';
  }

  toJSON(): string {
    return '**********';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret(**********)';
  }
}

const secret = z.string().min(1).transform((raw) => new Secret(raw));

const rawSchema = z.object({
  // ---------- apps/api and apps/auth ----------
  /** apps/api's base URL, no path. The client appends /api/v2/*. */
  BACKEND_SERVER_URL: z.url().default('http://localhost:3000'),
  /** apps/auth's base URL, no path. The auth client appends /api/whatsapp/session. */
  AUTH_SERVER_URL: z.url().default('http://localhost:3100'),
  /** Authenticates this service to apps/auth's /whatsapp endpoint (`Authorization: Bearer <key>`, issue #329). */
  AUTH_WHATSAPP_API_KEY: secret,

  // ---------- Meta Business API ----------
  META_API_VERSION: z.string().default('v26.0'),
  META_BUSINESS_PHONE_NUMBER_ID: secret,
  META_ACCESS_TOKEN_FROM_SYS_USER: secret,
  META_WEBHOOK_VERIFY_TOKEN: secret,
  /**
   * Verifies webhook signatures (X-Hub-Signature-256).
   * No default: a public default would let anyone forge signed webhooks.
   * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
   */
  META_ANSARI_APP_SECRET: secret,
  /**
   * Reply to the sender's phone number instead of their BSUID. Only for Meta's free test
   * number, whose allowed-recipient list holds phone numbers, so it cannot message a BSUID
   * (error 131030). A real number accepts BSUID replies. Refused in production.
   */
  META_REPLY_BY_PHONE: envBoolean(),

  // ---------- this service ----------
  ENVIRONMENT: z.enum(['development', 'staging', 'production']),
  /**
   * Meta needs an HTTP 200 for every webhook delivery. True: always answer 200, whatever
   * went wrong inside. False (automated tests only): return real error statuses.
   */
  ALWAYS_RETURN_OK_TO_META: envBoolean('true'),
  /** Comma-separated CORS origins. BACKEND_SERVER_URL and a few fixed origins are added automatically. */
  ORIGINS: z.string().default(''),

  // ---------- chat ----------
  /** This service's own maintenance switch, independent of apps/api's MAINTENANCE_MODE. */
  WA_MAINTENANCE_MODE: envBoolean(),
  /** The chat expiry for users who have not picked one with `/expiry`. apps/api accepts 0 to 24 hours. */
  WHATSAPP_CHAT_RETENTION_HOURS: z.coerce.number().int().min(0).max(24).default(3),
  /** Messages older than this are rejected instead of answered (default one day). */
  WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(86400),

  // ---------- logging ----------
  /** Empty means DEBUG when ENVIRONMENT is development, INFO everywhere else. */
  LOGGING_LEVEL: z.string().default(''),

  // ---------- service providers ----------
  /** Optional Sentry DSN; unset disables error reporting. */
  SENTRY_DSN: z
    .string()
    .optional()
    .transform((raw) => (raw && raw.length > 0 ? raw : undefined))
    .pipe(z.url('SENTRY_DSN must be a valid URL').optional()),
  MOCK_ANSARI_CLIENT: envBoolean(),
  MOCK_AUTH_CLIENT: envBoolean(),
  /** A real JWT the mock auth client returns for every BSUID, so a mocked sign-in can talk to a real apps/api. */
  // Unset and "" both mean "not set": an empty string is falsy.
  MOCK_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((raw) => (raw ? new Secret(raw) : undefined)),
  MOCK_META_API: envBoolean(),
  /** The port to listen on. Railway sets it; 3200 follows apps/api (3000) and apps/auth (3100). */
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
});

/**
 * The cross-field rules. Python counterpart: the `@model_validator(mode="after")` methods.
 * Each one reports against the variable the operator has to change.
 */
const schema = rawSchema
  .superRefine((cfg, ctx) => {
    if (cfg.ENVIRONMENT === 'development') return;
    // Mocks answer with canned data (and MOCK_AUTH_TOKEN puts every user in one
      // account), so only development may use them.
    const enabled: string[] = MOCK_FLAGS.filter((name) => cfg[name]);
    if (cfg.MOCK_AUTH_TOKEN) enabled.push('MOCK_AUTH_TOKEN');
    if (enabled.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: [enabled[0]!],
        message: `${enabled.join(', ')} only allowed when ENVIRONMENT=development (got ${cfg.ENVIRONMENT})`,
      });
    }
  })
  .superRefine((cfg, ctx) => {
    // Production answers on a real number, which takes BSUIDs, so no phone number should be read there.
    if (cfg.META_REPLY_BY_PHONE && cfg.ENVIRONMENT === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['META_REPLY_BY_PHONE'],
        message: 'META_REPLY_BY_PHONE is not allowed when ENVIRONMENT=production',
      });
    }
  })
  .transform((cfg) => {
    const loggingLevel = cfg.LOGGING_LEVEL || (cfg.ENVIRONMENT === 'development' ? 'DEBUG' : 'INFO');

    const origins = cfg.ORIGINS.replace(/^"|"$/g, '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    // BACKEND_SERVER_URL, the GitHub Actions testserver and WhatsApp Web are always allowed.
    for (const extra of [cfg.BACKEND_SERVER_URL, 'testserver', 'https://web.whatsapp.com']) {
      if (!origins.includes(extra)) origins.push(extra);
    }

    return {
      ...cfg,
      LOGGING_LEVEL: loggingLevel,
      ORIGINS: origins,
      /** https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages */
      META_API_URL: `https://graph.facebook.com/${cfg.META_API_VERSION}/${cfg.META_BUSINESS_PHONE_NUMBER_ID.reveal()}/messages`,
    };
  });

export type Env = z.output<typeof schema>;

/** Every variable the service reads. The env-template test checks each one is documented in `.env.example`. */
export const CONFIG_KEYS = Object.keys(rawSchema.shape);

/**
 * Validate an environment and return the settings, or throw one error that names every variable
 * failing its own check. The cross-field rules (mocks outside development, phone replies in production)
 * only run once every variable passes on its own, as with Pydantic's `mode="after"` validators, so
 * fixing the first round of errors can reveal one more.
 *
 * Takes the environment as an argument (default: the real one) so tests can pass their own
 * object. Python counterpart: `WhatsAppSettings()`; there the tests had to patch
 * `os.environ` and clear an `lru_cache`.
 */
export function buildConfig(env: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new Error(`WhatsApp service configuration is invalid (see apps/whatsapp/.env.example):\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** The process-wide settings, validated on first use. Python counterpart: `get_settings()`. */
export function getEnv(): Env {
  cached ??= buildConfig();
  return cached;
}

/** Test-only: forget the cached settings. Python counterpart: `get_settings.cache_clear()`. */
export function resetEnvCache(): void {
  cached = undefined;
}
