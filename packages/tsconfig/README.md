# @ansari/tsconfig

Shared TypeScript base for the workspace. Apps extend it and layer their own
framework settings on top.

## Why it is this small

It contains exactly the options **both** apps already had, so adopting it changed
neither app's resolved configuration — verified with `tsc --showConfig` before and
after.

`isolatedModules` is deliberately **not** here. `apps/api` sets it; `apps/frontend`
does not (it extends `expo/tsconfig.base`, which leaves it unset). Putting it in the
base would have silently turned it on for the frontend — a real behaviour change
disguised as a refactor. It stays in `apps/api/tsconfig.json`.

The rule: this base holds settings the apps genuinely agree on. Anything one app
needs and the other does not belongs in that app.

## Use

```jsonc
// an app that extends nothing else
{ "extends": "@ansari/tsconfig/base.json" }

// an app that already extends a framework base — order matters, later wins
{ "extends": ["expo/tsconfig.base", "@ansari/tsconfig/base.json"] }
```
