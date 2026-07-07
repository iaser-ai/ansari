import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_EXPIRY_HOURS: z.coerce.number().default(2),
  REFRESH_TOKEN_EXPIRY_HOURS: z.coerce.number().default(2160), // 90 days

  // AI - Facilitator (Gemini)
  // Either Vertex AI (preferred) or the public Gemini API must be configured.
  // Vertex is selected when GOOGLE_CLOUD_PROJECT is set; otherwise the SDK falls back to GEMINI_API_KEY.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.1-pro-preview'),
  // Fallback model used only when the primary model exhausts its retries on
  // transient (e.g. 429 shared-capacity) errors. Draws on a separate Vertex
  // capacity pool, so it can succeed when the primary is congested.
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.1-pro-preview'),

  // AI - Facilitator (Vertex AI)
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default('global'),
  // Path to a service-account JSON file (preferred for local dev).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Inline JSON contents of the service account (used on Railway / hosts without a file system).
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),

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
