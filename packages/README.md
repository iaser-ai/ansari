# packages/

Shared, internal workspace packages. Each is private, versioned `0.0.0`, and consumed by the
apps through `"workspace:*"` — they are never published, and their version numbers carry no
meaning. Apps live in [`apps/`](../apps); anything here exists because **more than one** of
them needs it.

| Package | Purpose |
|---|---|
| [`tsconfig/`](tsconfig) | Shared TypeScript base. Holds only options both apps already had, so adopting it changed neither app's resolved config. |
| [`eslint-config/`](eslint-config) | Shared ESLint flat-config base. Build-output ignores only — the apps' real configs (Next vs Expo) share almost nothing. |
| [`types/`](types) | Scaffold for shared API contract types. No contracts yet, by design. |

The convention these follow: **a shared package holds what its consumers genuinely agree on,
and nothing else.** A setting one app needs and the other does not belongs in that app, not
here — putting it in the base silently changes behaviour for everyone else, which is a real
change wearing a refactor's clothing. Both `tsconfig/` and `eslint-config/` document a
specific thing they deliberately exclude for that reason.
