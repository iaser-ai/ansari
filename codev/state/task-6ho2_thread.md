# task-6ho2 — drop legacy/whatsapp from Dependabot version updates

- Owner decision 2026-11-24: all of legacy/ is the old system and is excluded from Dependabot
  version updates, legacy/whatsapp included.
- `.github/dependabot.yml`: removed the `uv` entry for `/legacy/whatsapp` with its two comment
  lines; extended the npm entry's comment (kept the legacy/frontend-* archive note) to say all of
  legacy/ is excluded by that decision, legacy/whatsapp is still built and deployed (spec 321), and
  its security alerts are not affected by this file. Nothing else changed. YAML parses: entries are
  now npm `/` (exclude `legacy/**`) and github-actions `/`.
- Grep for statements that Dependabot watches legacy/whatsapp or its uv.lock (docs, RELEASE.md,
  CONTRIBUTING.md, legacy/whatsapp/README.md, tests, codev/resources, plus whole repo for files
  naming both "dependabot" and "whatsapp"): 0 hits outside dependabot.yml itself. Nothing to correct.
