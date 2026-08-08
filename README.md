# Ansari

**The most accurate, most helpful, free, open-source Islamic question-answering application.**

[Ansari](https://ansari.chat) answers Islamic questions with evidence: it searches the
Quran, Hadith collections, the Kuwaiti Encyclopedia of Islamic Jurisprudence (Mawsuah),
and Quranic exegesis (Tafsir), then synthesizes a cited, well-supported answer.

This is the Ansari monorepo, maintained by [IASER](https://iaser.ai) (the Islamic
Alliance for Safe, Ethical, and Responsible AI).

## Layout

| Directory | Contents |
|-----------|----------|
| [`backend/`](backend/) | The production backend: Next.js API, Gemini-powered facilitator, Islamic search tools |
| [`frontend/`](frontend/) | The Ask Ansari app: Expo / React Native (iOS, Android, and web via react-native-web) |
| [`docs/`](docs/) | Documentation, including the [self-hosting guide](docs/self-hosting.md) |

This is a [pnpm workspace](https://pnpm.io/workspaces): one `pnpm install` at the
repo root installs every package against the single root `pnpm-lock.yaml`.

## Quickstart

```bash
corepack enable        # provides pnpm (version pinned in package.json)
pnpm install           # once, at the repo root

# Backend
cd backend
cp .env.example .env   # fill in — see docs/self-hosting.md for the full contract
pnpm db:migrate
pnpm dev

# Frontend (from frontend/)
pnpm start             # Expo dev server (iOS / Android)
pnpm web               # web dev server
```

See [`docs/self-hosting.md`](docs/self-hosting.md) for prerequisites, the complete
environment-variable contract, and deployment notes.

## Contributing

Ansari is a [Codev](https://codevos.ai) project: development follows the Codev
methodology of AI-assisted engineering, with specs, plans, and reviews versioned
in [`codev/`](codev/). You don't need to know Codev to contribute — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) to get started.

Security issues: see [`SECURITY.md`](SECURITY.md) — please do not open public
issues for vulnerabilities.

## License

[MIT](LICENSE) © IASER
