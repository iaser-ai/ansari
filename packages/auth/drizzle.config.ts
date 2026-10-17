import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// The auth DATABASE_URL lives in the SERVICE's env file (apps/auth/.env), not in
// this package. `pnpm auth db:migrate` runs drizzle-kit here (cwd packages/auth),
// so load that file by path. A DATABASE_URL already in the shell wins (dotenv
// never overrides).
config({ path: '../../apps/auth/.env', quiet: true });

// Scoped to THIS package's schema and its own `out` dir. `drizzle-kit generate`
// therefore sees ONLY Better Auth's tables in the `auth` Postgres schema — it
// cannot emit ALTER/DROP against apps/api's `public` tables, which are described
// by a different drizzle.config (apps/api/drizzle.config.ts) entirely. This
// journal is the auth database's only journal (tests/migration/auth-journal-parity.test.ts).
//
// `generate` does not connect to the database (it diffs the schema against the
// migration folder), so an empty DATABASE_URL is fine for generation; a real URL
// is only needed for `migrate`. NEVER `db:push` (arch-critical) — the migration
// SQL is a reviewed artifact, human-applied at deploy.
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
