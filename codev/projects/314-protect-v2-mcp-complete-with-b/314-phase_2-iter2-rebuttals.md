# Phase 2, iteration 2: rebuttals

## Codex (REQUEST_CHANGES)

**Point: `key-window-volume` repeats once per key rate-limit window (60 s), so it can fire up to five times in one 5-minute `EXCHANGE_ALERT_WINDOW`. The spec says each MCP kind fires at most once per alert window.**

Accepted and fixed.

- `createKeyAlerts` takes a `keyWindowFloorMs` option: the shortest gap between two window-volume alerts for one key is `max(key window, floor)`. The MCP alerts set it to `EXCHANGE_ALERT_WINDOW`. The WhatsApp exchange keeps 0, so spec 329's behaviour and its tests are unchanged (the whatsapp suites pass untouched).
- New unit test (injected clock): a key over `MCP_VERIFY_KEY_ALERT` in every 60 s key window across one alert window raises exactly one alert, and the next alert window raises another. With the floor set to 0, that test fails (mutation-checked).
- Kept as designed: the per-key kinds stay per key (they carry `keyId`), as in the exchange. During a rotation's overlap, two live keys can each raise their own alert, which is what the operator needs.

## Gemini (APPROVE)

No issues raised.
