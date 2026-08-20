<!--
Thanks for contributing to Ansari! Keep PRs focused: one change per PR.
See CONTRIBUTING.md for the full guidelines.
-->

## Summary

<!-- What does this change do, and why? -->

## Related issue

<!-- e.g. "Closes #123". If there's no issue, briefly say what prompted this. -->

## Checks

All four must pass locally (run from `apps/api/`, with the dummy env in `apps/api/.env.ci`):

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`

## Contributor checklist

- [ ] Added or updated tests for any behavior change (Vitest is the regression net).
- [ ] No secrets or real `.env` files committed (`apps/api/.env.ci` holds fake placeholders only).
- [ ] Islamic-content changes (prompts, citations, source handling) cite the basis for the change
      — accuracy and proper sourcing are the core of this project.
