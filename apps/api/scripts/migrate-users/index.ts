/**
 * ============================================================================
 *  ⚠️  PARTIAL PORT — NOT VERIFIED AGAINST THE CURRENT SCHEMA — NOT FOR PROD  ⚠️
 * ============================================================================
 *
 * Ported from the archived `cluesmith/ansari-multisage` repo (issue #131) so the code
 * lives beside the schema it writes to and is covered by typecheck, lint and the pglite
 * test suite. That is ALL this port establishes. Nobody should run it against a real
 * database on the strength of it: columns added since the original's schema copy
 * (migrations 0002–0008) are marked `TODO(port)` at the insert sites and are NOT handled.
 *
 * Original job:  legacy ansari-backend (Python + MongoDB)  →  this Postgres schema.
 * NEXT job:      this Postgres schema (`users`/`threads`/`messages`)  →  the Better Auth
 *                based system (apps/auth, spec 59). For that:
 *   - source/*  (Mongo reader, content filter)     → becomes OBSOLETE; replace the reader
 *   - target/*  (user/thread migrators, rollback)  → gets REWRITTEN for Better Auth
 *                                                    (`name` vs first/last, scrypt vs bcrypt)
 *   - types.ts  (SourceUser/SourceThread/...)      → the seam; keep it stable
 *   - mapping-writer.ts                            → shared, unchanged
 *
 * Full module map, column inventory, test ledger and known gaps: ./README.md
 *
 * Usage (from apps/api/):   pnpm migrate-users <command> [options]
 *
 * Env: MONGO_URL and MONGO_DB_NAME are read from process.env by source/mongo-reader.ts
 * (deliberately NOT in lib/config.ts; declared in turbo.json globalEnv). DATABASE_URL is
 * validated through `config` — the #17 lint guard forbids raw reads, and lib/db/index.ts
 * validates the WHOLE Zod schema at import, so the script also needs JWT_SECRET,
 * KALEMAT_API_KEY and USUL_API_TOKEN present (same as scripts/grant-admin.ts).
 */
import { config } from '../../lib/config';
import { readUsers, closeMongo } from './source/mongo-reader';
import type { MigrateOptions, DeleteReadonlyOptions } from './types';

export const COMMANDS = ['migrate', 'delete-readonly'] as const;
export type Command = (typeof COMMANDS)[number];

export const DEFAULT_OUTPUT_PATH = 'tmp/migration-mapping.jsonl';

export interface ParsedArgs {
  command: string | undefined;
  options: { dryRun?: boolean; email?: string; fromFile?: string; output?: string };
}

/** Thrown by parseArgs on an unknown flag; main() prints usage and exits 1. */
export class UsageError extends Error {}

// --- Argument parsing ---

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  const options: ParsedArgs['options'] = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--email' && argv[i + 1]) {
      options.email = argv[++i];
    } else if (arg === '--from-file' && argv[i + 1]) {
      options.fromFile = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      options.output = argv[++i];
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  return { command, options };
}

export function usage(): string {
  return `
  ⚠️  PARTIAL PORT — not verified against the current schema — NOT FOR PRODUCTION USE.
      See scripts/migrate-users/README.md before running anything.

Usage: pnpm migrate-users <command> [options]

Commands:
  migrate           Migrate users (accounts + threads) from source to target
  delete-readonly   Delete all legacy/read-only data from target

Options:
  --email <email>     Scope to a single user by email
  --dry-run           Preview without writing to database
  --from-file <path>  Read from JSON file instead of MongoDB
  --output <path>     Mapping file path (default: ${DEFAULT_OUTPUT_PATH})
`;
}

function printUsage(): void {
  console.log(usage());
}

// --- Environment validation ---

/**
 * Names of the Mongo env vars the given invocation needs but `env` lacks. Pure so the
 * rule is testable without touching process.env: MONGO_* only for `migrate` when not
 * reading from a file; never for `delete-readonly`.
 */
export function missingMongoEnv(
  command: string,
  fromFile: string | undefined,
  env: Record<string, string | undefined>,
): string[] {
  if (command !== 'migrate' || fromFile) return [];
  const missing: string[] = [];
  if (!env.MONGO_URL) missing.push('MONGO_URL');
  if (!env.MONGO_DB_NAME) missing.push('MONGO_DB_NAME');
  return missing;
}

/**
 * The validated config's complaint about the database URL (and the rest of the runtime
 * schema — see the header), or null when it parses. Routed through `config` because the
 * eslint env guard forbids reading DATABASE_URL raw outside lib/config.ts.
 */
export function databaseConfigError(): string | null {
  try {
    void config.database.url;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function validateEnv(command: string, fromFile?: string): void {
  const missing = missingMongoEnv(command, fromFile, process.env);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const dbError = databaseConfigError();
  if (dbError) {
    console.error(`Missing required environment variables (DATABASE_URL and the runtime config it is validated with):\n${dbError}`);
    process.exit(1);
  }
}

// --- Command handlers ---

async function handleMigrate(options: MigrateOptions): Promise<void> {
  // Dynamic imports to avoid loading the DB pool before env validation
  const { migrateUser } = await import('./target/user-migrator');
  const { writeSummary } = await import('./mapping-writer');
  const { createThrottledSubscriber } = await import('../../lib/newsletter');
  const { closeDb } = await import('../../lib/db/index');

  console.log(`\nStarting migration${options.dryRun ? ' (DRY RUN)' : ''}...`);
  if (options.email) console.log(`  Scoped to: ${options.email}`);
  if (options.fromFile) console.log(`  Source: ${options.fromFile}`);
  console.log(`  Mapping file: ${options.outputPath}\n`);

  const throttledSubscribe = createThrottledSubscriber(60);

  try {
    const sourceUsers = await readUsers({
      fromFile: options.fromFile,
      email: options.email,
    });

    console.log(`Found ${sourceUsers.length} user(s) to process.\n`);

    const stats = {
      users: { total: sourceUsers.length, migrated: 0, skipped: 0, errors: 0 },
      threads: { total: 0, migrated: 0, skipped: 0, errors: 0 },
      messages: { total: 0, migrated: 0, filtered: 0 },
      newsletter: { subscribed: 0, failed: 0 },
    };

    for (const user of sourceUsers) {
      try {
        const result = await migrateUser(user, {
          dryRun: options.dryRun,
          outputPath: options.outputPath,
          fromFile: options.fromFile,
        });

        if (result.skipped) {
          console.log(`  SKIP ${user.email}: ${result.skipReason}`);
          stats.users.skipped++;
        } else if (result.isNew) {
          console.log(`  NEW  ${user.email} → ${result.postgresId} (${result.threadsInserted} threads, ${result.messagesInserted} messages)`);
          stats.users.migrated++;
        } else {
          console.log(`  EXIST ${user.email} → ${result.postgresId} (${result.threadsInserted} threads, ${result.messagesInserted} messages)`);
          stats.users.migrated++;
        }
        stats.threads.migrated += result.threadsInserted;
        stats.threads.skipped += result.threadsSkipped;
        stats.messages.migrated += result.messagesInserted;
        stats.messages.filtered += result.messagesFiltered;

        // Newsletter subscription (only for newly created users, not incremental thread migrations)
        if (!result.skipped && result.isNew) {
          if (options.dryRun) {
            const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
            console.log(`  [DRY RUN] Would subscribe: ${user.email} (name: "${name}", project: ansari, interests: [islamic])`);
          } else {
            const subResult = await throttledSubscribe(user.email, user.firstName, user.lastName);
            if (subResult.success) {
              console.log(`  NEWSLETTER ${user.email}: ${subResult.skipped ? 'skipped (not configured)' : 'subscribed'}`);
              if (!subResult.skipped) stats.newsletter.subscribed++;
            } else {
              console.warn(`  NEWSLETTER ${user.email}: failed — ${subResult.error}`);
              stats.newsletter.failed++;
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ERROR ${user.email}: ${message}`);
        // Drizzle wraps the driver error; the real Postgres reason is in err.cause.
        // Only {code, constraint} — never the driver's message/detail, which can embed
        // row contents (email, hash).
        const cause = (err as { cause?: unknown }).cause;
        if (cause && typeof cause === 'object') {
          const c = cause as { code?: string; constraint?: string };
          console.error(
            `    CAUSE ${user.email}:` +
              (c.code ? ` [code=${c.code}]` : '') +
              (c.constraint ? ` [constraint=${c.constraint}]` : ''),
          );
        }
        stats.users.errors++;
      }
    }

    // Write summary
    if (!options.dryRun && sourceUsers.length > 0) {
      const summary = {
        type: 'summary' as const,
        migratedAt: new Date().toISOString(),
        ...stats,
      };
      await writeSummary(options.outputPath, summary);
    }

    console.log('\n--- Summary ---');
    console.log(`Users:      ${stats.users.migrated} migrated, ${stats.users.skipped} skipped, ${stats.users.errors} errors`);
    console.log(`Threads:    ${stats.threads.migrated} migrated, ${stats.threads.skipped} skipped (empty)`);
    console.log(`Messages:   ${stats.messages.migrated} migrated, ${stats.messages.filtered} filtered`);
    console.log(`Newsletter: ${stats.newsletter.subscribed} subscribed, ${stats.newsletter.failed} failed`);
    if (options.dryRun) console.log('\nDry run complete. No changes made.');
  } finally {
    await closeDb();
  }
}

async function handleDeleteReadonly(options: DeleteReadonlyOptions): Promise<void> {
  const { deleteReadonly } = await import('./target/delete-readonly');
  const { closeDb } = await import('../../lib/db/index');

  console.log(`\nStarting delete-readonly...`);
  if (options.email) console.log(`  Scoped to: ${options.email}`);
  console.log(`  Mapping file: ${options.outputPath}\n`);

  try {
    const result = await deleteReadonly({
      email: options.email,
      mappingFile: options.outputPath,
    });

    console.log('\n--- Delete-Readonly Summary ---');
    console.log(`Messages deleted: ${result.messagesDeleted}`);
    console.log(`Threads deleted:  ${result.threadsDeleted}`);
    console.log(`Users deleted:    ${result.usersDeleted}`);
    console.log(`Users preserved:  ${result.usersPreserved}`);
  } finally {
    await closeDb();
  }
}

// --- Main ---

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      printUsage();
      process.exit(1);
    }
    throw err;
  }
  const { command, options } = parsed;

  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    printUsage();
    process.exit(1);
  }

  validateEnv(command, options.fromFile);

  const outputPath = options.output ?? DEFAULT_OUTPUT_PATH;

  try {
    if (command === 'migrate') {
      await handleMigrate({
        email: options.email,
        dryRun: !!options.dryRun,
        fromFile: options.fromFile,
        outputPath,
      });
    } else if (command === 'delete-readonly') {
      await handleDeleteReadonly({
        email: options.email,
        outputPath,
      });
    }
  } finally {
    await closeMongo();
  }
}

// Only run the CLI when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('migrate-users/index.ts')) {
  main().catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
