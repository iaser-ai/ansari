import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    // Fail-fast env validation at production server boot (never during
    // `next build`, dev or test). Imported dynamically so config is not pulled
    // into non-nodejs runtimes.
    const { validateEnvAtBoot } = await import("@/lib/boot-check");
    validateEnvAtBoot();
  }
}

export const onRequestError = Sentry.captureRequestError;
