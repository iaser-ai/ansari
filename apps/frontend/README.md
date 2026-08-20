# Ask Ansari — Frontend

The Ask Ansari app ([askansari.ai](https://askansari.ai)): an Expo / React
Native client for iOS, Android, and web (via react-native-web). It talks to the
backend in [`../api/`](../api/); the API surface is summarized in the
[api README](../api/README.md).

**Stack**: Expo SDK 57 (Expo Router, file-based routing under `src/app/`),
[HeroUI Native](https://heroui.com/docs/native) components,
[Uniwind](https://docs.uniwind.dev) (Tailwind CSS for React Native).

## Development

Install once at the repo root (pnpm workspace + Turborepo). `pnpm dev` from the
repo root starts this app alongside the API. To work on it alone, from this
directory:

```bash
pnpm start       # Expo dev server — press i / a for iOS / Android simulator
pnpm web         # web dev server
pnpm lint        # eslint
pnpm typecheck   # regenerates uniwind types, then tsc --noEmit
```

`expo-env.d.ts`, `uniwind-types.d.ts`, and `.expo/` are generated (gitignored);
`types.d.ts` is committed so typechecking works on fresh checkouts.

## Builds

### Native (EAS)

The app builds on [EAS](https://expo.dev/eas) as `@ansari-project/ansari-chat`
(bundle id `chat.ansari.app`). Profiles in `eas.json`:

| Profile | Use |
|---|---|
| `development` | Dev-client builds for simulators/devices (internal) |
| `preview` | Internal preview builds |
| `production-internal` | Production config, internal distribution |
| `production` | Store builds (auto-incremented, remote credentials) |

```bash
eas build --profile development --platform ios   # example
```

> ⚠️ `eas update --channel production` and `eas submit` reach real users.
> Day-to-day work uses the `development` / `preview` profiles.

`eas submit` (Play Store) needs `google-service-account/service-account.json`
locally — gitignored, never committed.

### Web

`pnpm build:web` exports a static SPA to `dist/` (`expo export`). Deployment is
a Caddy-served Docker image (`Dockerfile.web`, built from the repo root) on
Railway via `railway.toml`. `EXPO_PUBLIC_*` variables are baked in at build
time — set them on the Railway service; changing one requires a redeploy.
