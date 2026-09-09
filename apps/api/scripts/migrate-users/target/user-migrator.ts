/**
 * TARGET-SIDE: creates (or finds) the account for one source user in THIS repo's
 * `users` table and migrates their threads, all inside one transaction per user.
 *
 * Re-run semantics (preserved from the original):
 *   - an existing account (matched by normalized email) is never re-created or updated;
 *   - its already-migrated legacy threads are deduplicated by `threads.created_at`
 *     against rows with `source='legacy'`;
 *   - a source user with no threads (or none that survive the content filter) is
 *     skipped as an account.
 *
 * This is one of the modules that gets REWRITTEN for the next use (ansari-multisage →
 * Better Auth): `name` instead of first/last, scrypt-vs-bcrypt hash handling, a
 * different user table.
 *
 * Part of a PARTIAL PORT — NOT VERIFIED AGAINST THE CURRENT SCHEMA — NOT FOR PROD.
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../../../lib/db/index';
import { users, threads } from '../../../db/schema';
import { appendMapping } from '../mapping-writer';
import { migrateThreadsForUser } from './thread-migrator';
import { readThreadsForUser } from '../source/mongo-reader';
import type { SourceUser, SourceThread } from '../types';
import type { UserMapping } from '../mapping-writer';

export interface MigrateUserResult {
  postgresId: string;
  isNew: boolean;
  skipped: boolean;
  skipReason?: string;
  threadsInserted: number;
  messagesInserted: number;
  messagesFiltered: number;
  threadsSkipped: number;
}

type MigrateUserOptions = { dryRun: boolean; outputPath: string; fromFile?: string };

export async function migrateUser(
  sourceUser: SourceUser,
  options: MigrateUserOptions,
): Promise<MigrateUserResult> {
  // Check if user already exists in target (outside transaction for idempotency check)
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, sourceUser.email))
    .limit(1);

  if (existing.length > 0) {
    const existingUserId = existing[0].id;

    // Get existing legacy thread timestamps to deduplicate
    const legacyThreads = await db
      .select({ createdAt: threads.createdAt })
      .from(threads)
      .where(and(eq(threads.userId, existingUserId), eq(threads.source, 'legacy')));

    const existingTimestamps = new Set(
      legacyThreads.map((t) => t.createdAt!.getTime()),
    );

    // Migrate only threads not already present
    return migrateThreadsInTransaction(
      sourceUser,
      existingUserId,
      options,
      existingTimestamps,
    );
  }

  // User doesn't exist — check if they have any threads with messages
  const sourceThreads = await getSourceThreads(sourceUser, options);
  const hasMessages = sourceThreads.some(
    (t) => t.messages && t.messages.length > 0,
  );
  if (sourceThreads.length === 0 || !hasMessages) {
    return {
      postgresId: '',
      isNew: false,
      skipped: true,
      skipReason: 'no threads',
      threadsInserted: 0,
      messagesInserted: 0,
      messagesFiltered: 0,
      threadsSkipped: 0,
    };
  }

  if (options.dryRun) {
    console.log(`  [DRY RUN] Would insert user: ${sourceUser.email}`);
    const threadResult = await migrateThreadsForUser(
      sourceUser.mongoId,
      'dry-run-id',
      sourceThreads,
      null as never, // tx not used in dry-run
      { dryRun: true },
    );
    return {
      postgresId: 'dry-run-id',
      isNew: true,
      skipped: false,
      ...threadResult,
    };
  }

  return migrateInTransaction(sourceUser, options, sourceThreads);
}

async function getSourceThreads(
  sourceUser: SourceUser,
  options: { fromFile?: string },
): Promise<SourceThread[]> {
  // In JSON file mode, threads are embedded in the user object
  if (options.fromFile && sourceUser.threads) {
    return sourceUser.threads;
  }
  // In MongoDB mode, read threads separately
  if (!options.fromFile) {
    return readThreadsForUser(sourceUser.mongoId);
  }
  return [];
}

async function migrateInTransaction(
  sourceUser: SourceUser,
  options: MigrateUserOptions,
  sourceThreads?: SourceThread[],
): Promise<MigrateUserResult> {
  if (!sourceThreads) {
    sourceThreads = await getSourceThreads(sourceUser, options);
  }

  // All DB writes inside a single transaction
  const txResult = await db.transaction(async (tx) => {
    // Insert user. Timestamps come from the source (NOT lib/db/users.createUser, which
    // stamps now()).
    const [inserted] = await tx
      .insert(users)
      .values({
        email: sourceUser.email,
        passwordHash: sourceUser.passwordHash,
        firstName: sourceUser.firstName,
        lastName: sourceUser.lastName,
        source: sourceUser.source ?? 'web',
        createdAt: sourceUser.createdAt,
        updatedAt: sourceUser.updatedAt,
        // TODO(port): users.registered_via (0002) — X-Ansari-Client at register time;
        //   the source has no equivalent. Left at default (NULL).
        // TODO(port): users.is_admin (0003) — must NEVER be derived from source data
        //   (admin is granted only by scripts/grant-admin.ts). Left at default (false).
        // TODO(port): users.system_key (0003) — legacy users are never system accounts.
        //   Left at default (NULL). NOTE: no reserved-address check is applied here
        //   (registration refuses ADMIN_EMAILS / @system.ansari.chat via
        //   lib/auth/reserved.ts); see README "Known gaps".
        // TODO(port): users.session_version (0003) — a fresh account with no sessions;
        //   the default (0) is plausible but unverified.
      })
      .returning({ id: users.id });

    // Migrate threads within the same transaction
    const threadResult = await migrateThreadsForUser(
      sourceUser.mongoId,
      inserted.id,
      sourceThreads,
      tx,
      { dryRun: false },
    );

    return { userId: inserted.id, threadResult };
  });

  // After successful commit, write mapping entries
  const userMapping: UserMapping = {
    type: 'user',
    mongoId: sourceUser.mongoId,
    postgresId: txResult.userId,
    email: sourceUser.email,
  };
  await appendMapping(options.outputPath, userMapping);

  for (const threadMapping of txResult.threadResult.threadMappings) {
    await appendMapping(options.outputPath, threadMapping);
  }

  return {
    postgresId: txResult.userId,
    isNew: true,
    skipped: false,
    threadsInserted: txResult.threadResult.threadsInserted,
    messagesInserted: txResult.threadResult.messagesInserted,
    messagesFiltered: txResult.threadResult.messagesFiltered,
    threadsSkipped: txResult.threadResult.threadsSkipped,
  };
}

async function migrateThreadsInTransaction(
  sourceUser: SourceUser,
  existingUserId: string,
  options: MigrateUserOptions,
  existingTimestamps?: Set<number>,
): Promise<MigrateUserResult> {
  let sourceThreads = await getSourceThreads(sourceUser, options);

  // Filter out threads that already exist (by createdAt timestamp)
  if (existingTimestamps && existingTimestamps.size > 0) {
    const before = sourceThreads.length;
    sourceThreads = sourceThreads.filter(
      (t) => !existingTimestamps.has(t.createdAt.getTime()),
    );
    const deduped = before - sourceThreads.length;
    if (deduped > 0) {
      console.log(`  [dedup] ${deduped} threads already migrated, ${sourceThreads.length} new`);
    }
  }

  if (sourceThreads.length === 0) {
    return {
      postgresId: existingUserId,
      isNew: false,
      skipped: true,
      skipReason: 'no new threads',
      threadsInserted: 0,
      messagesInserted: 0,
      messagesFiltered: 0,
      threadsSkipped: 0,
    };
  }

  if (options.dryRun) {
    const threadResult = await migrateThreadsForUser(
      sourceUser.mongoId,
      existingUserId,
      sourceThreads,
      null as never,
      { dryRun: true },
    );
    return {
      postgresId: existingUserId,
      isNew: false,
      skipped: false,
      ...threadResult,
    };
  }

  // Threads-only transaction for existing users
  const txResult = await db.transaction(async (tx) => {
    return migrateThreadsForUser(
      sourceUser.mongoId,
      existingUserId,
      sourceThreads,
      tx,
      { dryRun: false },
    );
  });

  // After successful commit, write thread mapping entries
  for (const threadMapping of txResult.threadMappings) {
    await appendMapping(options.outputPath, threadMapping);
  }

  return {
    postgresId: existingUserId,
    isNew: false,
    skipped: false,
    threadsInserted: txResult.threadsInserted,
    messagesInserted: txResult.messagesInserted,
    messagesFiltered: txResult.messagesFiltered,
    threadsSkipped: txResult.threadsSkipped,
  };
}
