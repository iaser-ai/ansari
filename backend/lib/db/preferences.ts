import { eq, and } from 'drizzle-orm';
import { db } from './index';
import { preferences, type Preference, type NewPreference } from '@/db/schema';

export async function getPreferences(userId: string): Promise<Preference[]> {
  return db.select().from(preferences).where(eq(preferences.userId, userId));
}

export async function getPreference(
  userId: string,
  key: string
): Promise<Preference | undefined> {
  const result = await db
    .select()
    .from(preferences)
    .where(and(eq(preferences.userId, userId), eq(preferences.key, key)))
    .limit(1);
  return result[0];
}

export async function setPreference(
  userId: string,
  key: string,
  value: string
): Promise<Preference> {
  // Upsert - try to update, if not found insert
  const existing = await getPreference(userId, key);

  if (existing) {
    const result = await db
      .update(preferences)
      .set({ value, updatedAt: new Date() })
      .where(and(eq(preferences.userId, userId), eq(preferences.key, key)))
      .returning();
    return result[0];
  } else {
    const result = await db
      .insert(preferences)
      .values({ userId, key, value })
      .returning();
    return result[0];
  }
}

export async function deletePreference(userId: string, key: string): Promise<boolean> {
  const result = await db
    .delete(preferences)
    .where(and(eq(preferences.userId, userId), eq(preferences.key, key)))
    .returning();
  return result.length > 0;
}
