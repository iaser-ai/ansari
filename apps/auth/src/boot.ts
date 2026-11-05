// The boot assertion (spec 329, the #165 class: code shipped before its
// migration). Before listen(), apps/auth checks the schema spec 329 needs:
// the `auth.apikey` relation and `unique(provider_id, account_id)` on
// `auth.account`, both from migration 0001.
//
// It refuses to start ONLY on a definite answer that one is missing: Postgres
// 42P01 for the relation, or no row in the catalog for the constraint. Any
// other failure (the database unreachable, a timeout) lets the service start
// as it always has, with /health reporting the database: a blip at deploy must
// not become a crash loop that takes sign-in down with it. Every log line is
// `{name, code}` only.
import { hasAuthUniqueConstraint, redactError, schema, type Db } from '@ansari/auth';

const UNDEFINED_TABLE = '42P01';

/** The constraint migration 0001 adds (packages/auth `schema.ts`): one user per BSUID. */
export const BSUID_CONSTRAINT = 'account_provider_id_account_id_unique';
const BSUID_CONSTRAINT_TABLE = 'account';
const BSUID_CONSTRAINT_COLUMNS = ['provider_id', 'account_id'] as const;

export const SCHEMA_MISSING_MESSAGE = 'auth boot: schema missing, refusing to start (apply migration 0001 first)';
export const SCHEMA_UNCHECKED_MESSAGE = 'auth boot: schema check failed, starting anyway';

function codeOf(err: unknown): unknown {
  return err instanceof Error ? redactError(err).code : undefined;
}

const meta = (err: unknown) => (err instanceof Error ? redactError(err) : { name: 'unknown' });

/** True when apps/auth may start: the schema is there, or the database gave no definite answer. */
export async function assertSchema(db: Db): Promise<boolean> {
  try {
    await db.select({ id: schema.apikey.id }).from(schema.apikey).limit(1);
  } catch (err) {
    if (codeOf(err) === UNDEFINED_TABLE) {
      console.error(SCHEMA_MISSING_MESSAGE, meta(err));
      return false;
    }
    console.error(SCHEMA_UNCHECKED_MESSAGE, meta(err));
    return true;
  }
  try {
    if (await hasAuthUniqueConstraint(db, BSUID_CONSTRAINT_TABLE, BSUID_CONSTRAINT, BSUID_CONSTRAINT_COLUMNS)) return true;
    console.error(SCHEMA_MISSING_MESSAGE, { name: 'MissingConstraint', code: BSUID_CONSTRAINT });
    return false;
  } catch (err) {
    console.error(SCHEMA_UNCHECKED_MESSAGE, meta(err));
    return true;
  }
}
