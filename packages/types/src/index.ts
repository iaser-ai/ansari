/**
 * Shared API contract types for the Ansari monorepo.
 *
 * DELIBERATELY EMPTY of real contracts. Spec 48 scaffolds this package but does
 * not invent types: inventing a contract before a consumer needs one produces a
 * shape nobody validated against reality, and it is harder to remove than to add.
 *
 * The package is wired up (lint + typecheck run in the task graph and in CI) so
 * that the first real contract lands in a package already proven to build, rather
 * than discovering the scaffold was wrong at the moment someone needs it.
 *
 * To add a contract: extract it from the code that already produces or consumes
 * it — the API route and the client that calls it — rather than writing it fresh.
 */

/** Placeholder so the package has a real export and typechecks meaningfully. */
export const ANSARI_TYPES_PACKAGE = '@ansari/types' as const;

export type AnsariTypesPackage = typeof ANSARI_TYPES_PACKAGE;
