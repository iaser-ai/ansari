# Tests

Run from `legacy/whatsapp`:

```powershell
uv run pytest tests -q
uv run --with ruff ruff check .
```

`conftest.py` switches on all three mocks and sets dummy credentials, so no backend, auth service, Meta account or `.env` is needed. Exported environment variables take precedence over those defaults.

| File | What it covers |
|---|---|
| `test_whatsapp_service.py` | Health check, webhook verification, signature checks, basic message handling, phone-hidden users |
| `test_bsuid_auth_flow.py` | BSUID to token exchange, `apps/api` calls with that token, the chat event stream and its failure modes, no phone number or BSUID leaking to `apps/api` or logs |
| `test_thread_lifecycle.py` | One thread per user, reuse within the retention window, delete-and-recreate after it, failed deletion |
| `test_environment_behaviour.py` | `WA_MAINTENANCE_MODE` and the staging filter that ignores `!d ` messages |
| `test_railway_logging.py` | JSON log shape, level mapping, one line on stdout |

Notes:

- `test_utils.py` holds helpers for the service tests, not tests of its own.
- Everything in this suite runs against mocks and in-process fakes of HTTP calls, never a live `apps/auth`, `apps/api` or Meta. Live runs were done by hand; see the plan and the README.
- To see the service logs while testing, add `-s`.
