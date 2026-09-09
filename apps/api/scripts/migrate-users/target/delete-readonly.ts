/**
 * TARGET-SIDE: rollback. Deletes `source='legacy'` messages and threads (optionally
 * scoped to one account by email), then deletes accounts that (a) appear as `type:'user'`
 * entries in the mapping file — i.e. the migration created them — and (b) have no
 * remaining threads.
 *
 * Rows that hang off legacy threads/messages in tables this script never writes
 * (`feedback`, `shares`, `tool_call_orphans`) go with them via ON DELETE CASCADE.
 * TODO(port): `tool_call_orphans` (0007) post-dates the original; the cascade is the
 * only thing covering it. Unverified beyond the pglite test.
 *
 * Port change: row counts come from `.returning({ id })` instead of the driver's
 * `rowCount`, so the same code counts correctly under node-postgres and pglite.
 *
 * Part of a PARTIAL PORT — NOT VERIFIED AGAINST THE CURRENT SCHEMA — NOT FOR PROD.
 */
import { eq, and, ne } from 'drizzle-orm';
import { db } from '../../../lib/db/index';
import { users, threads, messages } from '../../../db/schema';
import { readMappingFile } from '../mapping-writer';

export interface DeleteReadonlyResult {
  messagesDeleted: number;
  threadsDeleted: number;
  usersDeleted: number;
  usersPreserved: number;
}

export async function deleteReadonly(options: {
  email?: string;
  mappingFile: string;
}): Promise<DeleteReadonlyResult> {
  const result: DeleteReadonlyResult = {
    messagesDeleted: 0,
    threadsDeleted: 0,
    usersDeleted: 0,
    usersPreserved: 0,
  };

  // Step 1: Delete legacy messages
  if (options.email) {
    // Scope to user's threads
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, options.email))
      .limit(1);

    if (userRows.length === 0) {
      console.log(`No user found with email: ${options.email}`);
      return result;
    }

    const userId = userRows[0].id;

    // Get legacy thread IDs for this user
    const legacyThreadRows = await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.userId, userId), eq(threads.source, 'legacy')));

    if (legacyThreadRows.length > 0) {
      const threadIds = legacyThreadRows.map((t) => t.id);

      // Delete legacy messages belonging to legacy threads
      for (const threadId of threadIds) {
        const deletedMessages = await db
          .delete(messages)
          .where(and(eq(messages.threadId, threadId), eq(messages.source, 'legacy')))
          .returning({ id: messages.id });
        result.messagesDeleted += deletedMessages.length;
      }

      // Delete legacy threads
      const deletedThreads = await db
        .delete(threads)
        .where(and(eq(threads.userId, userId), eq(threads.source, 'legacy')))
        .returning({ id: threads.id });
      result.threadsDeleted += deletedThreads.length;
    }

    // Check if user should be deleted (no remaining threads + in mapping file)
    await deleteUserIfMapped(userId, options.mappingFile, options.email, result);
  } else {
    // Bulk: delete all legacy messages and threads
    const deletedMessages = await db
      .delete(messages)
      .where(eq(messages.source, 'legacy'))
      .returning({ id: messages.id });
    result.messagesDeleted = deletedMessages.length;

    const deletedThreads = await db
      .delete(threads)
      .where(eq(threads.source, 'legacy'))
      .returning({ id: threads.id });
    result.threadsDeleted = deletedThreads.length;

    // Delete mapped users who have no remaining threads
    await deleteMappedUsers(options.mappingFile, result);
  }

  return result;
}

async function deleteUserIfMapped(
  userId: string,
  mappingFile: string,
  email: string,
  result: DeleteReadonlyResult,
): Promise<void> {
  // Check mapping file for this user
  let mappingEntries;
  try {
    mappingEntries = await readMappingFile(mappingFile);
  } catch {
    console.warn(`Mapping file not found: ${mappingFile}. User account preserved.`);
    result.usersPreserved++;
    return;
  }

  const userMapping = mappingEntries.find(
    (e) => e.type === 'user' && 'email' in e && e.email === email,
  );

  if (!userMapping) {
    console.log(`User ${email} not found in mapping file. Account preserved.`);
    result.usersPreserved++;
    return;
  }

  // Check if user has any remaining (non-legacy) threads
  const remainingThreads = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.userId, userId), ne(threads.source, 'legacy')))
    .limit(1);

  if (remainingThreads.length > 0) {
    console.log(`User ${email} has non-legacy threads. Account preserved.`);
    result.usersPreserved++;
    return;
  }

  // Safe to delete
  const deletedUsers = await db
    .delete(users)
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  result.usersDeleted += deletedUsers.length;
}

async function deleteMappedUsers(
  mappingFile: string,
  result: DeleteReadonlyResult,
): Promise<void> {
  let mappingEntries;
  try {
    mappingEntries = await readMappingFile(mappingFile);
  } catch {
    console.warn(`Mapping file not found: ${mappingFile}. User accounts preserved.`);
    return;
  }

  const userEntries = mappingEntries.filter((e) => e.type === 'user');

  for (const entry of userEntries) {
    if (!('postgresId' in entry)) continue;
    const postgresId = entry.postgresId as string;
    const email = 'email' in entry ? (entry.email as string) : 'unknown';

    // Check if user has any remaining threads
    const remainingThreads = await db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.userId, postgresId))
      .limit(1);

    if (remainingThreads.length > 0) {
      console.log(`User ${email} has non-legacy threads. Account preserved.`);
      result.usersPreserved++;
      continue;
    }

    // Check if user still exists (may have been deleted by cascade or manually)
    const userExists = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, postgresId))
      .limit(1);

    if (userExists.length === 0) continue;

    const deletedUsers = await db
      .delete(users)
      .where(eq(users.id, postgresId))
      .returning({ id: users.id });
    result.usersDeleted += deletedUsers.length;
  }
}
