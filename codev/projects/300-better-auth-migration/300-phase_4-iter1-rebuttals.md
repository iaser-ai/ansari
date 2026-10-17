# Phase 4, iteration 1: responses

Codex returned REQUEST_CHANGES (HIGH confidence) with two issues, and both are ACCEPTED. Gemini's report was cut off before its verdict line, and the text that did arrive raises no issue.

## 1. Requests the router refuses never reach the counting hook (accepted)

Correct. better-auth's router runs its rate limiter in `onRequest`, before any hook (`dist/api/index.mjs`, router `onRequest`). Its built-in 3/60 s rule on `/request-password-reset` therefore refused requests before apps/auth counted them toward the per-IP and per-email reset budgets. The spec requires every request to count.

Fix:
- `ROUTER_RULES['/request-password-reset']` is now `false`. It is not simply omitted, because an absent rule falls back to the built-in 3/60 s.
- apps/auth enforces `RESET_REQUEST_BURST` itself, on a separate `ip-burst:` key. Every request is counted against all three windows (burst, 15-minute IP cap, 1-hour email cap) before any decision is made.

New tests:
- Five requests from one IP in a minute: two are refused by the burst, and the IP cap still records 5. After the burst window, the next request is refused by the 15-minute cap.
- An email whose first request was refused by the burst reaches its cap one request sooner, from other IPs.
- The router's custom rule for the path is `false`.

With the old arrangement restored (the rule back on the router, the burst check removed), these tests fail: 6 failures across both modes.

## 2. `ipBucket` mishandles hex IPv4-mapped IPv6 (accepted)

Correct. `::ffff:cb00:7105` was grouped as an IPv6 /64, which put every such client in one bucket. `ipBucket` is now a faithful port of `@better-auth/core`'s `normalizeIP`, including `extractIPv4FromMapped` for the dotted, seven-part and hex forms, and the full eight-group /64 output.

New tests:
- The hex, expanded and upper-case forms.
- A parity test: a sign-in from each of four IPs (hex-mapped, dotted-mapped, IPv6, IPv4) lands in exactly the router key `${ipBucket(ip)}|/sign-in/email` that better-auth computes.

When the hex branch is broken, these tests fail: 4 failures.

## Checks

Build is green. Tests: @ansari/auth 158 + 1 deliberate skip, ansari-auth 111, api 934 + 3, frontend 624.
