/**
 * Shared API contract types for the Ansari monorepo.
 *
 * Spec 48 scaffolded this package without inventing types: inventing a contract
 * before a consumer needs one produces a shape nobody validated against reality,
 * and it is harder to remove than to add. The first real export is
 * `@ansari/types/attribution` (spec 300), the X-Ansari-Client parser, moved out
 * of apps/api because apps/auth needs the identical rule.
 *
 * The package is wired up (lint + typecheck run in the task graph and in CI) so
 * that the first real contract lands in a package already proven to build, rather
 * than discovering the scaffold was wrong at the moment someone needs it.
 *
 * To add a contract: extract it from the code that already produces or consumes
 * it — the API route and the client that calls it — rather than writing it fresh.
 *
 * This package exports raw `.ts`, with no build step. Each consumer compiles
 * it: apps/api through `transpilePackages` in next.config.ts, apps/auth by
 * bundling @ansari/* with tsdown, and packages/auth's tests through vitest. A
 * consumer that cannot transpile workspace dependencies would need a build step
 * added here first.
 */

/** Placeholder so the package has a real export and typechecks meaningfully. */
export const ANSARI_TYPES_PACKAGE = '@ansari/types' as const;

export type AnsariTypesPackage = typeof ANSARI_TYPES_PACKAGE;
