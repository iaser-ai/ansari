# TODO

## Environment variables

The app reads its configuration from `EXPO_PUBLIC_*` variables (see `dotenv.example`). Expo
inlines every `EXPO_PUBLIC_*` value into the JavaScript bundle when the app is built
(`npm run build`, i.e. `expo export`); nothing is read from the environment at runtime. The
Dockerfile declares each one as a build `ARG` and sets it as `ENV` for the build, so on Railway
the service variables reach the build as build args.

### Maintenance mode (`MAINTENANCE_MODE`)

When on, the whole app is replaced by a maintenance screen ("Ansari is currently under
maintenance."), the same screen the legacy mobile app shows. It is decided from the variable
alone: no request is made to the api, and the store (which fetches `/users/me` for a signed-in
user) is never built.

- **Name.** On Railway, set `MAINTENANCE_MODE`, the same name as on the api service. The
  Dockerfile maps the build arg to `EXPO_PUBLIC_MAINTENANCE_MODE`, which is the name the app
  reads (through `src/utils/getEnv.ts`) and the one to use in a local `.env`.
- **Values.** The same on-values as the api's `MAINTENANCE_MODE`: `true`, `True` or `1` turn it on.
  Unset, empty, `false`, `False`, `0` and any other value leave it OFF, so an unset variable never
  shows the screen. This differs from the api for an unrecognised value: the api's `z.enum`
  refuses to boot on one, while this build treats it as OFF.
- **Baked in at build time.** Turning it on or off takes a rebuild and redeploy of the web
  service. On Railway, changing the variable triggers that redeploy; the switch takes effect
  when the new deployment is live, not when the variable is saved.
- **Open tabs.** A browser tab that already loaded the app keeps running the build it loaded
  until it is reloaded. `index.html` is served `Cache-Control: no-cache` (see `Caddyfile`), so a
  reload picks up the new build.
