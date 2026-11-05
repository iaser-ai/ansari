// Better Auth's Drizzle schema: every table it owns, in the `auth` Postgres
// schema of the AUTH database (spec 300, "Two databases"). Only apps/auth
// reaches that database; the app database keeps `public.users` under the same
// UUIDs and shares no Drizzle code with this module.
//
// Shapes follow better-auth 1.7.7's own generator for this configuration
// (`generateId: 'uuid'`, `user.modelName: 'users'`, the jwt, admin and api-key
// plugins, database rate-limit storage, and the additional user fields), with
// these deliberate departures:
//   - every table lives in `pgSchema('auth')`, not `public`;
//   - every timestamp is `timestamptz`, because the legacy `public.users`
//     values being copied in are `timestamptz` (success criterion, scenario 12);
//   - `account` carries `unique(user_id, provider_id)`, so a user has at most
//     one credential row, and `unique(provider_id, account_id)`, so a provider
//     id (a WhatsApp BSUID) maps to exactly one user under concurrency (spec 329);
//   - `apikey.reference_id` is a uuid referencing `users` with cascade delete,
//     where the plugin declares a plain string: a key always belongs to a
//     service user (spec 329).
// Ids are `uuid` with a `gen_random_uuid()` default: the pg Drizzle adapter
// reports `supportsUUIDs`, so better-auth leaves id generation to the database,
// and the copy inserts the legacy UUIDs explicitly.
//
// This module intentionally has NO env dependency, so it can be imported
// standalone by `drizzle.config.ts` (for `drizzle-kit generate`) and by tests
// without triggering env validation or a DB connection.
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

const tstz = (name: string) => timestamp(name, { withTimezone: true });
const uuidPk = () =>
  uuid('id')
    .default(sql`pg_catalog.gen_random_uuid()`)
    .primaryKey();

export const users = authSchema.table('users', {
  id: uuidPk(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: tstz('created_at').defaultNow().notNull(),
  updatedAt: tstz('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  // admin plugin
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: tstz('ban_expires'),
  // additional fields carried over from public.users
  firstName: text('first_name'),
  lastName: text('last_name'),
  registeredVia: text('registered_via'),
});

export const session = authSchema.table(
  'session',
  {
    id: uuidPk(),
    expiresAt: tstz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // admin plugin
    impersonatedBy: text('impersonated_by'),
  },
  (table) => [index('session_userId_idx').on(table.userId)]
);

export const account = authSchema.table(
  'account',
  {
    id: uuidPk(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('account_userId_idx').on(table.userId),
    unique('account_user_id_provider_id_unique').on(table.userId, table.providerId),
    unique('account_provider_id_account_id_unique').on(table.providerId, table.accountId),
  ]
);

export const verification = authSchema.table(
  'verification',
  {
    id: uuidPk(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)]
);

// jwt plugin
export const jwks = authSchema.table('jwks', {
  id: uuidPk(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: tstz('created_at').notNull(),
  expiresAt: tstz('expires_at'),
  alg: text('alg'),
  crv: text('crv'),
});

// rateLimit.storage: 'database'
export const rateLimit = authSchema.table('rate_limit', {
  id: uuidPk(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// api-key plugin (spec 329). Keys are created only by apps/auth's operator
// script; `key` holds the SHA-256 hash, never the key itself. Defaults are the
// plugin's own (one configuration: rate limit on, 10 per day).
export const apikey = authSchema.table(
  'apikey',
  {
    id: uuidPk(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: uuid('reference_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: tstz('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: tstz('last_request'),
    expiresAt: tstz('expires_at'),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('apikey_configId_idx').on(table.configId),
    index('apikey_referenceId_idx').on(table.referenceId),
    index('apikey_key_idx').on(table.key),
  ]
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(users, {
    fields: [session.userId],
    references: [users.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(users, {
    fields: [account.userId],
    references: [users.id],
  }),
}));
