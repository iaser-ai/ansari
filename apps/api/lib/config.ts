import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_EXPIRY_HOURS: z.coerce
    .number()
    .int('ACCESS_TOKEN_EXPIRY_HOURS must be an integer')
    .positive('ACCESS_TOKEN_EXPIRY_HOURS must be greater than 0')
    .default(2),
  REFRESH_TOKEN_EXPIRY_HOURS: z.coerce
    .number()
    .int('REFRESH_TOKEN_EXPIRY_HOURS must be an integer')
    .positive('REFRESH_TOKEN_EXPIRY_HOURS must be greater than 0')
    .default(2160), // 90 days

  // AI - Facilitator (Gemini)
  // Either Vertex AI (preferred) or the public Gemini API must be configured.
  // Vertex is selected when GOOGLE_CLOUD_PROJECT is set; otherwise the SDK falls back to GEMINI_API_KEY.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  // Used ONLY by gemini-client's intra-Vertex 429 failover (#45): when the
  // primary model's capacity pool is congested, the call hops to this model's
  // separate Vertex pool in milliseconds. NOT part of the empty-final retry
  // ladder (#79) — degradation that survives a same-model retry escalates
  // straight to Inkling (off Vertex) instead.
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.1-pro-preview'),

  // AI - Facilitator (Vertex AI)
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default('global'),
  // Path to a service-account JSON file (preferred for local dev).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Inline JSON contents of the service account (used on Railway / hosts without a file system).
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),

  // AI - Inkling (issues #74/#79). The facilitator's off-Vertex backup on
  // Tinker infrastructure: the second rung of the empty-final retry ladder AND
  // the one-shot rescue when a Gemini call fails terminally with budget left.
  // Optional: when unset both are skipped cleanly (logged once) and the ladder
  // is the single same-model retry.
  TINKER_API_KEY: z.string().optional(),

  // AI - Primary backend switch (issue #95). EXPERIMENTATION ONLY — NOT a
  // supported production configuration. PRIMARY_BACKEND=inkling routes every
  // facilitator primary call through the OpenAI-compatible client instead of
  // Gemini (benchmark runs through the full pipeline, exported LoRAs, a
  // Gemini-outage escape hatch). INKLING_BASE_URL points that client at any
  // OpenAI-compatible /chat/completions endpoint (default: the Tinker prod
  // URL); INKLING_API_KEY authenticates it, falling back to TINKER_API_KEY.
  PRIMARY_BACKEND: z.enum(['gemini', 'inkling']).default('gemini'),
  INKLING_BASE_URL: z
    .string()
    .url('INKLING_BASE_URL must be a valid URL (full /chat/completions endpoint)')
    .default(
      'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/chat/completions'
    ),
  INKLING_API_KEY: z.string().min(1, 'INKLING_API_KEY must not be empty when set').optional(),

  // Islamic Tools
  KALEMAT_API_KEY: z.string().min(1, 'KALEMAT_API_KEY is required'),
  USUL_API_TOKEN: z.string().min(1, 'USUL_API_TOKEN is required'),
  USUL_BASE_URL: z.string().default('https://api.usul.ai/v1/vector-search'),

  // Admin
  ADMIN_EMAILS: z.string().optional().default(''),

  // External evaluation harnesses (e.g. IslamicMMLU leaderboard) authenticate
  // against /v1/chat/completions with this bearer token. Optional in dev.
  LEADERBOARD_API_KEY: z.string().min(32).optional(),

  // App version control
  MAINTENANCE_MODE: z
    .enum(['true', 'false', 'True', 'False', '1', '0'])
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),
  IOS_MINIMUM_BUILD_VERSION: z.coerce.number().int().default(1),
  IOS_LATEST_BUILD_VERSION: z.coerce.number().int().default(1),
  ANDROID_MINIMUM_BUILD_VERSION: z.coerce.number().int().default(1),
  ANDROID_LATEST_BUILD_VERSION: z.coerce.number().int().default(1),

  // Optional
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
}).superRefine((env, ctx) => {
  // Fail fast at boot, not at first chat request: an inkling primary with no
  // credential would otherwise serve a server whose every completion fails.
  if (env.PRIMARY_BACKEND === 'inkling' && !env.INKLING_API_KEY && !env.TINKER_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PRIMARY_BACKEND'],
      message:
        'PRIMARY_BACKEND=inkling requires INKLING_API_KEY (or TINKER_API_KEY as fallback)',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(`Environment validation failed:\n${result.error.toString()}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * Test-only: clear the memoized env so a subsequent `getEnv()` re-parses
 * `process.env`. Needed because `getEnv()` caches the first successful parse,
 * and config-validation tests must exercise multiple env states in one file.
 * Has no effect on production behavior (only ever called from tests).
 */
export function resetEnvCache(): void {
  cachedEnv = null;
}

// For use in server-side code only
export const config = {
  get database() {
    return {
      url: getEnv().DATABASE_URL,
    };
  },

  get auth() {
    return {
      jwtSecret: getEnv().JWT_SECRET,
      accessTokenExpiryHours: getEnv().ACCESS_TOKEN_EXPIRY_HOURS,
      refreshTokenExpiryHours: getEnv().REFRESH_TOKEN_EXPIRY_HOURS,
    };
  },

  get gemini() {
    const env = getEnv();
    const project = env.GOOGLE_CLOUD_PROJECT;
    const useVertex = !!project;

    if (!useVertex && !env.GEMINI_API_KEY) {
      throw new Error(
        'Gemini is not configured: set GOOGLE_CLOUD_PROJECT (Vertex) or GEMINI_API_KEY (public API).'
      );
    }

    return {
      model: env.GEMINI_MODEL,
      fallbackModel: env.GEMINI_FALLBACK_MODEL,
      useVertex,
      apiKey: env.GEMINI_API_KEY,
      vertex: {
        project,
        location: env.GOOGLE_CLOUD_LOCATION,
        credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
        credentialsJson: env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
      },
    };
  },

  get inkling() {
    const env = getEnv();
    return {
      apiKey: env.INKLING_API_KEY ?? env.TINKER_API_KEY,
      baseUrl: env.INKLING_BASE_URL,
    };
  },

  /**
   * Which client serves the facilitator's PRIMARY calls (issue #95).
   * 'gemini' (default) is the supported production configuration; 'inkling'
   * is an env-gated experimentation switch that routes the whole request
   * through the OpenAI-compatible client at config.inkling.baseUrl.
   */
  get primaryBackend() {
    return getEnv().PRIMARY_BACKEND;
  },


  get tools() {
    return {
      kalemat: {
        apiKey: getEnv().KALEMAT_API_KEY,
      },
      usul: {
        apiToken: getEnv().USUL_API_TOKEN,
        baseUrl: getEnv().USUL_BASE_URL,
      },
    };
  },

  get leaderboard() {
    return {
      apiKey: getEnv().LEADERBOARD_API_KEY,
    };
  },

  get admin() {
    const raw = getEnv().ADMIN_EMAILS;
    return {
      emails: raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    };
  },

  get appVersion() {
    return {
      maintenanceMode: getEnv().MAINTENANCE_MODE,
      ios: {
        minimumBuild: getEnv().IOS_MINIMUM_BUILD_VERSION,
        latestBuild: getEnv().IOS_LATEST_BUILD_VERSION,
      },
      android: {
        minimumBuild: getEnv().ANDROID_MINIMUM_BUILD_VERSION,
        latestBuild: getEnv().ANDROID_LATEST_BUILD_VERSION,
      },
    };
  },

  get isDevelopment() {
    return getEnv().NODE_ENV === 'development';
  },

  get isProduction() {
    return getEnv().NODE_ENV === 'production';
  },
};
