import { config } from '@/lib/config';
import { findUserByEmail } from '@/lib/db/users';

/**
 * Fail-fast startup assertion (spec 4): every configured admin address
 * (`ADMIN_EMAILS`) must already resolve to a user row flagged `is_admin`.
 *
 * Because public registration of admin addresses is refused and admin access is
 * gated on the DB flag, the ONLY way to create an admin is out-of-band
 * (scripts/grant-admin.ts). Asserting existence at boot turns a mis-provisioned
 * deploy (stale/deleted admin, allowlist typo) into an immediate, loud failure
 * instead of a silent self-registration window.
 *
 * Deploy ordering (runbook): migration → admin bootstrap → deploy. If this throws
 * on boot, the bootstrap step was skipped.
 *
 * Throws on the first configured admin that is missing or not flagged. A DB query
 * runs here, so boot is coupled to DB reachability (accepted fail-fast).
 */
export async function assertConfiguredAdminsExist(): Promise<void> {
  const emails = config.admin.emails;
  if (emails.length === 0) return; // nothing configured → nothing to assert

  for (const email of emails) {
    const user = await findUserByEmail(email);
    if (!user) {
      throw new Error(
        `Admin bootstrap check failed: configured admin '${email}' has no account. ` +
          `Run scripts/grant-admin.ts before deploy (runbook: migration → bootstrap → deploy).`
      );
    }
    if (!user.isAdmin) {
      throw new Error(
        `Admin bootstrap check failed: configured admin '${email}' exists but is not flagged is_admin. ` +
          `Run scripts/grant-admin.ts to grant it.`
      );
    }
  }
}

/**
 * Gate for `assertConfiguredAdminsExist`, kept separate so the assertion itself
 * stays trivially testable. The check runs ONLY in a running production Node
 * server — never during `next build` (whose worker sets NEXT_PHASE), and never in
 * dev/test/CI (where ADMIN_EMAILS may be empty or point at non-existent rows and
 * the DB is typically unreachable).
 */
export function shouldRunAdminStartupCheck(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === 'production' &&
    env.NEXT_RUNTIME === 'nodejs' &&
    env.NEXT_PHASE !== 'phase-production-build'
  );
}
