# air-381 thread

- 2026-11-12: `test:coverage` in apps/api/turbo.json was missing 13 of `test`'s 21 inputs. Made the two lists identical and added the guard `apps/api/tests/turbo-coverage-inputs.test.ts`, which compares them as sets. Its comment stripper skips string contents because globs like `apps/*/src/**` contain `/*`.
- Hash proof (`turbo run test:coverage --filter=ansari-api --dry=json`, whitespace edit then restore): before the fix, editing RELEASE.md or apps/auth/railway.toml left the hash unchanged. After the fix, editing RELEASE.md, apps/auth/railway.toml, legacy/whatsapp/railway.toml, docs/self-hosting.md or .gitleaks.toml changed it, and restoring the file returned the original hash.
- Negative test: dropping RELEASE.md from `test:coverage` fails the guard, and restoring it makes the guard pass.
