/**
 * SEAM between the source side (scripts/migrate-users/source/*) and the target side
 * (scripts/migrate-users/target/*). A future source reader (e.g. one that reads this
 * repo's own Postgres `users`/`threads`/`messages` for the Better Auth import) must
 * produce these shapes; the target writers consume nothing else.
 *
 * Part of a PARTIAL PORT — see scripts/migrate-users/README.md.
 */

export interface SourceUser {
  /** Source-system primary key as a string (Mongo ObjectId hex today). */
  mongoId: string;
  email: string;
  passwordHash: string;
  firstName: string | null;
  lastName: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Present only when the reader embeds threads (JSON-file mode). */
  threads?: SourceThread[];
}

export interface SourceThread {
  mongoId: string;
  name: string | null;
  messages: SourceMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceMessage {
  mongoId: string;
  role: string;
  content: string | ContentBlock[];
  createdAt: Date | null;
}

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface MigrateOptions {
  email?: string;
  dryRun: boolean;
  fromFile?: string;
  outputPath: string;
}

export interface DeleteReadonlyOptions {
  email?: string;
  outputPath: string;
}
