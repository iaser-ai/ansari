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
| [`apps/api/`](apps/api/) | The production backend: Next.js API, Gemini-powered facilitator, Islamic search tools |
| [`apps/frontend/`](apps/frontend/) | The Ansari app: Expo / React Native (iOS, Android, and web via react-native-web) |
| [`docs/`](docs/) | Documentation, including the [self-hosting guide](docs/self-hosting.md) |

This is a [pnpm workspace](https://pnpm.io/workspaces) driven by
[Turborepo](https://turborepo.com): one `pnpm install` at the repo root installs
every package against the single root `pnpm-lock.yaml`, and root tasks
(`pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`) fan out
across the workspace through one cached task graph.

## Quickstart

```bash
corepack enable        # provides pnpm (version pinned in package.json)
pnpm install           # once, at the repo root

# One-time backend setup — from the repo root
cd apps/api
cp .env.example .env   # fill in — see docs/self-hosting.md for the full contract
pnpm db:migrate
cd ../..

# Then, from the repo root: starts the API, the auth service and the app
# (auth needs its own one-time setup: see CONTRIBUTING.md)
pnpm dev
```

`pnpm dev` needs a real terminal (it uses Turbo's interactive UI so the Expo
keypress shortcuts keep working). For a single app: `pnpm api dev`, `pnpm auth dev`, or
`pnpm frontend web` for the web target; `pnpm dev:no-auth` skips the auth service.

See [`docs/self-hosting.md`](docs/self-hosting.md) for prerequisites, the complete
environment-variable contract, and deployment notes.

## Contributing

Ansari is a [Codev](https://codevos.ai) project: development follows the Codev
methodology of AI-assisted engineering, with specs, plans, and reviews versioned
in [`codev/`](codev/). Developing with
[Codev](https://github.com/cluesmith/codev) is strongly recommended — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) to get started, and its
[Codev section](CONTRIBUTING.md#developing-with-codev-strongly-recommended) for
working from a fork.

Security issues: see [`SECURITY.md`](SECURITY.md) — please do not open public
issues for vulnerabilities.

## License

[MIT](LICENSE) © IASER

## Faithful Answers MCP application

[`apps/ansari-faithful-answers`](apps/ansari-faithful-answers/README.md) exposes Ansari answers through MCP with a self-contained React card for assistant hosts. It uses public saga a2ui packages, embedded Kitab fonts and local artwork. Start it separately with `pnpm faithful-answers build` then `pnpm faithful-answers start`; see its README for environment variables and its standalone Docker build.
