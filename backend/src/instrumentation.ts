import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    // Fail-fast admin bootstrap check (spec 4). Gated to a running production
    // Node server (never during `next build`, dev, or test) so it does not query
    // an unreachable CI/build DB. Imported dynamically so the db/config modules
    // are not pulled into non-nodejs runtimes.
    const { assertConfiguredAdminsExist, shouldRunAdminStartupCheck } = await import(
      "@/lib/auth/startup-checks"
    );
    if (shouldRunAdminStartupCheck()) {
      await assertConfiguredAdminsExist();
    }
  }
}

export const onRequestError = Sentry.captureRequestError;
