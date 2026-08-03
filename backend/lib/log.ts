/**
 * Extract log-safe metadata from an error: its type name and, for DB driver
 * errors, the SQLSTATE `code` — never the message, query text, or params (any of
 * which can carry user content: an email, a password hash, request body fields).
 *
 * Walks the `.cause` chain because drizzle wraps the driver error in
 * DrizzleQueryError (the pg/pglite error, which carries `code`, is nested under
 * `.cause`) — same traversal as isUniqueViolation in lib/db/users.ts. The name
 * comes from `constructor.name` since wrapper classes like DrizzleQueryError
 * keep the inherited `name: 'Error'`.
 *
 * Use this instead of logging a raw caught error in any route's catch block
 * (backend CLAUDE.md: no user content in logs; issue #19).
 */
export function safeErrorMeta(error: unknown): { name: string; code?: string } {
  const name =
    error instanceof Error ? error.constructor?.name || error.name : typeof error;
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return { name, code };
    e = (e as { cause?: unknown }).cause;
  }
  return { name };
}
