import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Scoped to THIS package's schema and its own `out` dir. `drizzle-kit generate`
// therefore sees ONLY Better Auth's four new tables — it cannot emit ALTER/DROP
// against apps/api's tables (users/tokens/threads/...), which are described by a
// different drizzle.config (apps/api/drizzle.config.ts) entirely.
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
