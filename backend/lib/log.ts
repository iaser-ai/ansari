/**
 * Extract log-safe metadata from an error: its type name and, for DB driver
 * errors, the SQLSTATE `code` — never the message, query text, or params (any of
 * which can carry user content: an email, a password hash, request body fields).
 *
 * Use this instead of logging a raw caught error in any route's catch block
 * (backend CLAUDE.md: no user content in logs; issue #19).
 */
export function safeErrorMeta(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? { name, code } : { name };
}
