# Spec 314 — iteration 1 rebuttals

Changes landed in commit "[Spec 314] Specification with multi-agent review", together with the security architect's answers of 2026-11-11.

## Codex (REQUEST_CHANGES)

1. **Open-tier decision unresolved.** Partly accepted. This is an owner decision, and the owner's evidence (the `threads.client` query) is not in yet. The security architect directed the spec to proceed on option (a), close it, with (b) kept specified as the alternative and the decision carried at the spec gate. The Assumptions now say so. Every success criterion and the rollout are written for (a). §3 states what (b) changes: header-less requests get (b)'s capped tier after enforcement, and a failing key is still 401.
2. **`key_id` missing in apps/api test 4.** Fixed. Both `key_id` and `client_id` are always present on `valid: true`. apps/api treats a `valid: true` missing either field, or carrying an off-pattern `client_id`, as a malformed answer (503). This is tested in apps/api scenario 7.
3. **Service-user lookup order.** Fixed. The lookup runs only after the plugin accepts the key, so a refused key is `valid: false` whatever the service user's state. The 500 applies only to a key that passed. This is tested in apps/auth scenario 7, both ways.
4. **The "no prefix in any DB column" conflict with `apikey.prefix`.** Fixed. The rule now covers the raw key and any substring of its random part. The public `ansari_mcp_` prefix is explicitly exempt, since it is stored by the plugin and published by the secret-scanning pattern.
5. **Byte and key bounds, and the `client_id` alert contract.** Fixed. The body limit is 1 KiB. `key` is 1 to 256 printable non-whitespace ASCII characters. A new alert kind, `client-id-invalid`, carries the key id and fires once per `EXCHANGE_ALERT_WINDOW`. The architect also constrained `client_id` to `ansari-mcp` or `ansari-mcp-<suffix>`.

## Gemini (COMMENT)

- **`list` does not print `client_id`.** Accepted. `list` will select `metadata` and print each key's `client_id`, in the spec and in apps/auth test 14.
- **Disagreement warning semantics.** Specified. The header is parsed alone (`parseClientId`, not `getClientId`), and one `mcp-complete client mismatch` warning fires for a malformed or differing header. The raw value is never sent, and no separate invalid-header event fires. `?src=` is silently ignored on keyed requests.
- **Error envelope.** Accepted. 401 is `{ error: 'Unauthorized' }` and 503 is `{ error: 'Authentication service unavailable' }`, matching the route's existing `{ error }` shape.
- **The runtime type of `metadata`.** Accepted, as apps/auth test 15.
- **Latency in log-only on an apps/auth timeout.** Noted in §3 as accepted for the transition week.

## Security architect (2026-11-11, folded in)

- The closed permission set is kept, with two distinct tests:
  - a request asking for a permission outside the set is 400 before any key is touched;
  - a well-formed request presenting a WhatsApp key is the same refusal as an unknown key, with the budget as the plugin leaves it.
- The 400 body names no permission.
- `MCP_COMPLETE_KEY_MODE` takes exactly `log-only` or `enforce`, absent means enforce, and anything else is rejected at production boot. It is derived four ways, and the `turbo.json` hunk is main's.
- Log-only serves even when apps/auth is unreachable (`unverified`, plus a Sentry warning).
- A dated follow-up removes log-only a week after enforcement.
- The live MCP server is the owner-operated `mcp.ansari.chat`. The snippet and setup page are out of repository and recorded as owner steps.
