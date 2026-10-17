import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // @ansari/types exports raw `.ts` (no build step), so Next must compile it.
  transpilePackages: ["@ansari/types"],
  // Lint runs as its own step (`pnpm lint`) and in CI; keep `next build`
  // decoupled from ESLint so the build gate isn't coupled to lint findings.
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        // CORS for all API routes (spec 300, scenario 28). apps/api is
        // bearer-only: no cookies, so no credentialed CORS. Allow-Credentials is
        // never sent, which makes the wildcard origin safe: a browser refuses any
        // credentialed cross-origin request, and a bearer request reads only
        // what its own token already allows. A static wildcard also has no
        // per-environment allowlist to get wrong; headers() is compiled at
        // build, and the image builds with the dummy .env.ci.
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,DELETE,PATCH,POST,PUT,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, X-Ansari-Client, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version" },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig);
