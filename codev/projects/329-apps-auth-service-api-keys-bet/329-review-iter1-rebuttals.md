# PR review (review phase), iteration 1: response

## Codex (REQUEST_CHANGES) 1: merge is blocked (`AUTH_DEPLOYED_THROUGH` null, no `0001` apply record, staging not verified)

**Not changed now. This is the agreed merge precondition, not a defect, and it is stated in the PR body.**

Per the security architect's standing order, `AUTH_DEPLOYED_THROUGH` goes to `0001`, with a second `auth-journal-applied: 0001_api_key_phone` line in `RELEASE.md`, at the **rebase after spec 300's production cutover**. develop is frozen for apps/auth and packages/auth until then, and `0000` itself is not yet applied in production. Bumping now would assert an apply that has not happened. That is exactly the false assertion the parity test's design warns against (arch-critical: "the bump is a human ASSERTION"). The order: the duplicate pre-check, then apply `0001` to staging before merge and verify, then apply to production before the develop → main promote. It is in the PR body and in `docs/cutover/service-keys-runbook.md`. The skipped parity test (`@ansari/auth`, 1 skipped) is the loud marker that this is still open.

## Codex (REQUEST_CHANGES) 2: `grant-admin --revoke <noreply>` bypasses the reserved-domain check

**The docs are narrowed and the behaviour is pinned. The code is not changed, on purpose.**

- Revoke only lowers a role to `user`. It cannot grant anything, so it opens no path to privilege.
- It is the repair the runbook prescribes for the eligibility reason `admin` (a WhatsApp user found holding `admin`). Refusing it on noreply addresses would leave only hand-written SQL for that repair.
- Parity with the spec: the criterion reads "refuses a noreply address, as it refuses the system domain". The system domain has never been refused on revoke either (spec 300), so the two domains already behave alike.
- The real defect was the wording. `arch.md` (twice), `RELEASE.md` and the script's header said "refuses the noreply domain" without qualification. All of them now say it never **grants** to a system- or noreply-domain address and that `--revoke` is allowed for any account. The runbook's repair step now names `grant-admin.ts --revoke <email>`.
- Regression test (`apps/auth/tests/grant-admin.test.ts`): a noreply user seeded as `admin` is refused a grant (`NoreplyAddressError`), and `--revoke` demotes it to `user`. Negative run: with Codex's suggested change (the noreply check moved above the revoke branch), the test goes red (1 failed, 14 passed). Restored: 15/15.
- Also green: apps/api `cutover-docs` and `self-hosting-docs` (117), and apps/auth typecheck and lint.

## Gemini (COMMENT)

Skipped (agy exit 3), as in every earlier round. Non-blocking; nothing to address.
