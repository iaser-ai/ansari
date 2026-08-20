# @ansari/eslint-config

Shared ESLint flat-config base. Spread it first, then layer the app's own config.

```js
import ansari from '@ansari/eslint-config/base';

export default [
  ...ansari,
  // framework config and app rules here
];
```

## Why it is this small

The two apps share almost nothing: `apps/api` bridges `eslint-config-next` via
`FlatCompat` and adds a bespoke config-bypass rule; `apps/frontend` spreads
`eslint-config-expo`. The honest intersection is build-output ignore globs, so that
is what this contains. A larger shared config would be a worse abstraction than none.

**The api's `no-restricted-properties` env guard is deliberately not here.** It
enforces that auth secrets are read only through the validated `config` object, and
its allowlist names backend-relative paths that mean nothing in an Expo app. Security
rules belong where their allowlist is meaningful.

Adoption changed neither app's reported violations — verified by diffing
`eslint -f json` output before and after.
