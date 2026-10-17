// The `name` better-auth requires on every user, derived by the reference rule
// (spec 300, success criteria) when a client sends none. The cutover copy
// applies the same rule in SQL to every migrated user.
//
//   trim(first || ' ' || last) when non-empty, else the email local-part,
//   else 'User'.
//
// `name` is never split back into first and last.
export function deriveName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  email: string | null | undefined
): string {
  const full = `${firstName ?? ''} ${lastName ?? ''}`.trim();
  if (full) return full;
  const localPart = (email ?? '').split('@')[0]?.trim() ?? '';
  if (localPart) return localPart;
  return 'User';
}
