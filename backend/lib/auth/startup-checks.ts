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

  for (let i = 0; i < emails.length; i++) {
    // Identify the failing entry by its position in ADMIN_EMAILS, never by the
    // address itself — this error is logged at boot and must carry no email
    // content (project logging convention). The operator maps the index back to
    // their configured list.
    const label = `configured admin #${i + 1} of ${emails.length} (from ADMIN_EMAILS)`;

    let user;
    try {
      user = await findUserByEmail(emails[i]);
    } catch {
      // A transient DB outage at boot must read as such, not as a missing admin,
      // so on-call triage doesn't chase a provisioning problem that isn't there.
      throw new Error(
        `Admin bootstrap check could not reach the database while verifying ${label}. Retry once the database is reachable.`
      );
    }

    if (!user) {
      throw new Error(
        `Admin bootstrap check failed: ${label} has no account. ` +
          `Run scripts/grant-admin.ts before deploy (runbook: migration → bootstrap → deploy).`
      );
    }
    if (!user.isAdmin) {
      throw new Error(
        `Admin bootstrap check failed: ${label} exists but is not flagged is_admin. ` +
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
