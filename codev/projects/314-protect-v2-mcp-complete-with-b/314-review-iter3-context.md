# PR #372 re-review (iteration 3): owner scope expansion

Iterations 1-2 approved the original change (iter1 codex's bearer-envelope fix landed in d88eb58e). Since then the owner widened scope during review (spec Amendments 2 and 3, under the spec's title), built as review-phase commits 2977d3d0 and 7f3ab68d:

- `ENVIRONMENT` (development|staging|production) in apps/api and apps/auth Zod schemas; required and staging/production under NODE_ENV=production, enforced only on the existing boot paths; the Sentry environment of both services.
- Every service-key prefix names its environment: `ansari_<service>_<ENVIRONMENT>_`. The service-keys script reads ENVIRONMENT from its process env (no flag) and refuses without it.
- The WhatsApp exchange and the MCP verify route refuse, with their ordinary refusal, any verified key whose stored `apikey.prefix` is not their own service's and own ENVIRONMENT's; the legacy bare prefix is accepted while `LEGACY_UNLABELLED_KEYS` holds.
- turbo.json globalEnv, env templates, RELEASE.md, runbook, self-hosting, deploy guide.

Please review the whole PR, focusing on the new commits: correctness of the boot enforcement (never at build), the route prefix check, the derived scanning patterns, test coverage, and doc consistency.
