// The outage check the key-holding routes (the WhatsApp exchange, the MCP
// verify route) run on every plugin refusal. The plugin reports a database
// failure (an outage, `auth.apikey` missing) as INVALID_API_KEY, the code of
// an unknown key. A query on `auth.apikey` itself (not `select 1`, which
// passes with the relation gone) tells them apart; a success is trusted for
// APIKEY_RELATION_CHECK_TTL, so an outage that starts inside that window is
// still read as a refusal (the accepted residual, spec 329).
import { limits, schema, type Db } from '@ansari/auth';

/** A check bound to one route's cache; it throws when `auth.apikey` cannot be read. */
export function createApiKeyRelationCheck(db: Db, now: () => number = Date.now): () => Promise<void> {
  let checkedAt: number | null = null;
  return async function checkApiKeyRelation(): Promise<void> {
    const at = now();
    if (checkedAt !== null && at - checkedAt < limits.APIKEY_RELATION_CHECK_TTL) return;
    await db.select({ id: schema.apikey.id }).from(schema.apikey).limit(1);
    checkedAt = at;
  };
}
