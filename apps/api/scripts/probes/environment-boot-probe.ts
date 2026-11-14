/**
 * The production-shaped run for ENVIRONMENT (#314 Amendment 3; second review,
 * finding 12): the BUILT apps/api started with `next start` and
 * NODE_ENV=production, as Railway starts it, for each value of ENVIRONMENT.
 * In-process tests (tests/boot-check.test.ts) call validateEnvAtBoot directly;
 * this proves the rule on the real boot path, through instrumentation's
 * register(). Operator-run, after `pnpm --filter ansari-api build`:
 *
 *   pnpm --filter ansari-api exec tsx scripts/probes/environment-boot-probe.ts <unreachable database URL>
 *
 * The database URL is an argument, never read from the environment, and
 * should point at a port nothing listens on: the probe needs boot to get past
 * the env check, not a database. Only the values below exist in the child.
 *
 * Next.js prints "Ready" even when register() throws, so the verdict is the
 * healthcheck Railway runs: a refused boot answers /api/health 500 and logs
 * the ENVIRONMENT rule (names only, no value); a good boot gets past the env
 * check, answering 503 without a database (or 200 with one). Each case runs
 * under a deadline (PASS or FAIL, never a hang). The output is pasted into the
 * review (codev/reviews/314-*.md).
 */
import { spawn } from "node:child_process";
import path from "node:path";

const databaseUrl = process.argv[2];
if (!databaseUrl) {
  console.error("usage: environment-boot-probe.ts <unreachable database URL>");
  process.exit(2);
}

const APP_DIR = path.resolve(__dirname, "../..");
const PORT = "31996";
const AUDIENCE = "ansari-api-probe-audience";
const BASE: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  NODE_ENV: "production",
  DATABASE_URL: databaseUrl,
  KALEMAT_API_KEY: "probe",
  USUL_API_TOKEN: "probe",
  AUTH_URL: "https://auth.probe.test",
  AUTH_JWT_ISSUER: "https://auth.probe.test",
  AUTH_JWT_AUDIENCE: AUDIENCE,
  AUTH_LAYER_ORIGIN: "https://api.probe.test",
};

type Outcome = { health: number | null; ruleLogged: boolean; leaked: boolean };

async function healthAfterReady(
  output: () => string,
  deadline: number,
): Promise<number | null> {
  while (Date.now() < deadline) {
    if (/Ready in/.test(output())) {
      try {
        return (await fetch(`http://127.0.0.1:${PORT}/api/health`)).status;
      } catch {
        // not listening yet
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function boot(
  environment: string | undefined,
  deadlineMs = 40_000,
): Promise<Outcome> {
  const env = {
    ...BASE,
    ...(environment === undefined ? {} : { ENVIRONMENT: environment }),
  };
  const child = spawn(
    path.join(APP_DIR, "node_modules/.bin/next"),
    ["start", "-p", PORT],
    {
      cwd: APP_DIR,
      env,
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const health = await healthAfterReady(() => output, Date.now() + deadlineMs);
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  return {
    health,
    // The validation failure names ENVIRONMENT: the production rule for an
    // absent or `development` value, Zod's enum message for any other.
    ruleLogged: /Environment validation failed[\s\S]*ENVIRONMENT/.test(output),
    leaked:
      output.includes(AUDIENCE) ||
      (environment !== undefined && output.includes(`"${environment}"`)),
  };
}

async function main(): Promise<number> {
  let failed = 0;
  for (const [environment, shouldBoot] of [
    [undefined, false],
    ["development", false],
    ["prod", false],
    ["staging", true],
    ["production", true],
  ] as const) {
    const outcome = await boot(environment);
    const ok = shouldBoot
      ? outcome.health !== null && outcome.health !== 500 && !outcome.ruleLogged
      : outcome.health === 500 && outcome.ruleLogged && !outcome.leaked;
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  NODE_ENV=production ENVIRONMENT=${environment ?? "(absent)"} → /api/health ${outcome.health ?? "no answer"}` +
        `${outcome.ruleLogged ? ", ENVIRONMENT rule logged" : ""}`,
    );
  }
  return failed;
}

// apps/api is CommonJS: no top-level await.
void main().then((failed) => process.exit(failed === 0 ? 0 : 1));
