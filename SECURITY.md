# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

- **Preferred**: use GitHub's [private vulnerability reporting](https://github.com/iaser-ai/ansari/security/advisories/new)
  ("Report a vulnerability" under the repository's Security tab).
- **Email (interim)**: `feedback@ansari.chat` — clearly mark the subject with
  `[SECURITY]`. *(This is a placeholder contact while a dedicated `security@`
  alias is being set up.)*

We will acknowledge reports as quickly as we can, keep you informed of progress,
and credit reporters who wish to be credited once a fix ships.

## Scope

The production backend in `backend/` (API, authentication, data handling) and
anything deployed at `api-35.ansari.chat`. Please practice responsible
disclosure: no testing against production user data, no denial-of-service.
