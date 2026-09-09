/**
 * SOURCE-SIDE: reads legacy ansari-backend users/threads from MongoDB (or from a JSON
 * export of them) and normalizes into the `types.ts` shapes.
 *
 * This is the module that becomes OBSOLETE at the next use: the ansari-multisage →
 * Better Auth import reads this repo's own Postgres instead. Replace with a
 * `source/postgres-reader.ts` producing the same `SourceUser[]`; nothing on the target
 * side needs to change for that swap.
 *
 * Env: `MONGO_URL`, `MONGO_DB_NAME` are read here directly from `process.env` — they are
 * deliberately NOT part of the runtime Zod config (lib/config.ts); the CLI validates
 * them before this module is asked to connect. Both are declared in turbo.json
 * `globalEnv` (strict env mode) so they reach the task at all.
 *
 * Part of a PARTIAL PORT — see scripts/migrate-users/README.md.
 */
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { readFile } from 'fs/promises';
import type { SourceUser, SourceThread, SourceMessage } from '../types';

// --- Extended JSON parsing helpers ---

export function parseExtendedJsonId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof ObjectId) return value.toHexString();
  if (value && typeof value === 'object' && '$oid' in value) {
    return (value as { $oid: string }).$oid;
  }
  // Handle any object with a toHexString method (ObjectId-like)
  if (value && typeof value === 'object' && 'toHexString' in value && typeof (value as { toHexString: () => string }).toHexString === 'function') {
    return (value as { toHexString: () => string }).toHexString();
  }
  throw new Error(`Cannot parse ID from: ${JSON.stringify(value)}`);
}

export function parseExtendedJsonDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  if (value && typeof value === 'object' && '$date' in value) {
    return new Date((value as { $date: string }).$date);
  }
  throw new Error(`Cannot parse date from: ${JSON.stringify(value)}`);
}

// --- Normalization ---

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeMessage(raw: Record<string, unknown>): SourceMessage {
  const id = raw.id ?? raw._id;
  return {
    mongoId: id ? parseExtendedJsonId(id) : '',
    role: (raw.role as string) ?? 'user',
    content: raw.content as string | SourceMessage['content'],
    createdAt: raw.created_at ? parseExtendedJsonDate(raw.created_at) : null,
  };
}

function normalizeThread(raw: Record<string, unknown>): SourceThread {
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map((m: Record<string, unknown>) => normalizeMessage(m))
    : [];

  return {
    mongoId: parseExtendedJsonId(raw._id ?? raw.id),
    name: (raw.name as string) ?? null,
    messages,
    createdAt: parseExtendedJsonDate(raw.created_at ?? raw.createdAt),
    updatedAt: parseExtendedJsonDate(raw.updated_at ?? raw.updatedAt ?? raw.created_at ?? raw.createdAt),
  };
}

function normalizeUser(raw: Record<string, unknown>): SourceUser {
  const threads = Array.isArray(raw.threads)
    ? raw.threads.map((t: Record<string, unknown>) => normalizeThread(t))
    : undefined;

  return {
    mongoId: parseExtendedJsonId(raw._id ?? raw.id),
    email: normalizeEmail((raw.email as string) ?? ''),
    passwordHash: (raw.password_hash as string) ?? (raw.passwordHash as string) ?? '',
    firstName: (raw.first_name as string) ?? (raw.firstName as string) ?? null,
    lastName: (raw.last_name as string) ?? (raw.lastName as string) ?? null,
    source: (raw.source as string) ?? null,
    createdAt: parseExtendedJsonDate(raw.created_at ?? raw.createdAt),
    updatedAt: parseExtendedJsonDate(raw.updated_at ?? raw.updatedAt ?? raw.created_at ?? raw.createdAt),
    threads,
  };
}

/** Drop users the migration cannot or must not create (no email / no hash / guest). */
function filterInvalidUsers(users: SourceUser[]): SourceUser[] {
  return users.filter((u) => {
    if (!u.email) {
      console.warn(`Skipping user with no email (mongoId: ${u.mongoId})`);
      return false;
    }
    if (!u.passwordHash) {
      console.warn(`Skipping user with no password hash: ${u.email}`);
      return false;
    }
    if (u.email.startsWith('guest_')) {
      return false;
    }
    return true;
  });
}

// --- Deduplication ---

export function deduplicateUsers(users: SourceUser[]): SourceUser[] {
  const byEmail = new Map<string, SourceUser>();

  for (const user of users) {
    const existing = byEmail.get(user.email);
    if (!existing || user.createdAt > existing.createdAt) {
      byEmail.set(user.email, user);
    }
  }

  return Array.from(byEmail.values());
}

// --- JSON file reader ---

export async function readUsersFromFile(
  filePath: string,
  email?: string,
): Promise<SourceUser[]> {
  const raw = await readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw);

  const rawArray: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
  let users = filterInvalidUsers(rawArray.map(normalizeUser));

  // Email filter
  if (email) {
    const target = normalizeEmail(email);
    users = users.filter((u) => u.email === target);
  }

  return deduplicateUsers(users);
}

// --- MongoDB reader ---

let client: MongoClient | null = null;
let database: Db | null = null;

async function getDb(): Promise<Db> {
  if (database) return database;

  const url = process.env.MONGO_URL;
  const dbName = process.env.MONGO_DB_NAME;
  if (!url || !dbName) {
    throw new Error('MONGO_URL and MONGO_DB_NAME environment variables are required');
  }

  client = new MongoClient(url);
  await client.connect();
  database = client.db(dbName);
  return database;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    database = null;
  }
}

export async function readUsersFromMongo(email?: string): Promise<SourceUser[]> {
  const db = await getDb();
  const collection = db.collection('users');

  const filter = email ? { email: normalizeEmail(email) } : {};
  const docs = await collection.find(filter).toArray();

  const users = filterInvalidUsers(
    docs.map((doc) => normalizeUser(doc as unknown as Record<string, unknown>)),
  );

  return deduplicateUsers(users);
}

export async function readThreadsForUser(userId: string): Promise<SourceThread[]> {
  const db = await getDb();
  const collection = db.collection('threads');

  // MongoDB stores user_id as ObjectId — query with both to be safe
  const objectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;
  const filter = objectId
    ? { $or: [{ user_id: objectId }, { user_id: userId }] }
    : { user_id: userId };

  const docs = await collection.find(filter).toArray();
  return docs.map((doc) => normalizeThread(doc as unknown as Record<string, unknown>));
}

// --- Unified reader ---

export async function readUsers(options: {
  fromFile?: string;
  email?: string;
}): Promise<SourceUser[]> {
  if (options.fromFile) {
    return readUsersFromFile(options.fromFile, options.email);
  }
  return readUsersFromMongo(options.email);
}
