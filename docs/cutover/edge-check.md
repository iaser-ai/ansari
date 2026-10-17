# Edge check: is `X-Real-IP` the client's address? (spec 300, plan P-4)

`apps/auth` keys the router's per-IP default on `X-Real-IP` (`advanced.ipAddress.ipAddressHeaders`),
and `apps/api` keys its per-IP limits on the `/v2/users` layer's routes on the same header. No
path the layer calls is keyed by IP on `apps/auth` (spec H-4), and nothing forwards the header
between the services any more. Both per-IP keys are only sound if Railway's edge **overwrites**
`X-Real-IP` with the real client address on every domain, and gives different clients different
addresses. This file holds the method and the recorded observations. The verdict selects no mode
(`AUTH_RATE_LIMIT_MODE` is removed, H-4); a failure goes to the security architect (window step
14's abort).

## Method

The probes (removed by the contract PR) return only what the edge says about the **caller
itself**, with `Cache-Control: no-store`. They return:
- `x_real_ip`
- the number of `X-Forwarded-For` entries, and whether the first is `x_real_ip` (never the
  entries' values)
- the `CF-Connecting-IP` that arrived
- `via_cloudflare` (`cf-ray` or `cdn-loop: cloudflare` present)

The probe routes:
- `apps/api`: `GET /api/v2/_diag/client-ip`
- `apps/auth`: `GET /__diag/client-ip`

Every domain is probed on **both paths** where it has them: through Cloudflare, and direct to
Railway's edge. For staging, the owner first orange-clouds `api-staging.askansari.ai` (and
`auth-staging.askansari.ai` once attached), so the staging check covers the Cloudflare path that
`api.askansari.ai` uses.

On each path, over IPv4 and over IPv6 where reachable, run the probe with all three client-IP
headers forged (`<probe>` is the route above for that service):

```bash
FORGED=(-H 'X-Real-IP: 192.0.2.66' -H 'X-Forwarded-For: 192.0.2.66' -H 'CF-Connecting-IP: 192.0.2.66')
URL=https://<domain>/<probe>

# Via Cloudflare (the orange-clouded hostname resolves to Cloudflare), each family forced:
curl -4 -s "${FORGED[@]}" "$URL"
curl -6 -s "${FORGED[@]}" "$URL"     # Cloudflare publishes AAAA

# Direct to Railway's edge, with the same Host and SNI. The edge addresses are the
# service's *.up.railway.app records:
EDGE_V4=$(dig +short A <service>.up.railway.app | tail -1)
curl -4 -s "${FORGED[@]}" --resolve "<domain>:443:${EDGE_V4}" "$URL"
EDGE_V6=$(dig +short AAAA <service>.up.railway.app | tail -1)
if [ -n "$EDGE_V6" ]; then
  curl -6 -s "${FORGED[@]}" --resolve "<domain>:443:[${EDGE_V6}]" "$URL"
else
  echo "direct IPv6: not reachable (no AAAA for <service>.up.railway.app)"
fi
```

Record every cell, including an unreachable one, as "not reachable" with the reason. Never
leave it blank. On 2026-10-17, neither `oqn57cug.up.railway.app` (api-staging) nor
`vyex12qb.up.railway.app` (api-35) had an AAAA record, so the direct path is IPv4 only unless
that changes.

Each path passes on two properties:
1. **Overwrite.** `x_real_ip` is your real address, never `192.0.2.66`. A `cf_connecting_ip` of
   `192.0.2.66` on the direct path is expected: Railway passes it through verbatim, which is why
   nothing may trust it.
2. **Distinctness.** Probing from two different networks (for example home and a phone hotspot)
   gives two different `x_real_ip` values.

**Record the shapes.** For each path, record the probe's JSON with every real address replaced
by an RFC 5737 address, using the scheme in
[`edge-header-shapes.json`](edge-header-shapes.json). Those shapes then replace the provisional
ones in that file, which apps/auth's public-listener tests and apps/api's `getRealIp` tests
read. The staging verdict is recorded only after **both** paths are measured.

**Pre-merge passive check of each production domain** (no code deployed): record the `dig` chain
and the `curl -sI` headers, which show whether Cloudflare is in front.

The **in-window production probe** (G-2, window steps 11 and 14; the auth domain's moved to step
11 with its attach, spec H-5) runs the same two paths on the production domains and stays the
final word.

## Observations (phase 13 and the window)

| Domain | When | IPv4 overwrite | IPv6 overwrite | Distinct | Notes |
|---|---|---|---|---|---|
| `api-staging.askansari.ai` via Cloudflare (once orange-clouded) | phase 13 | | | | |
| `api-staging.askansari.ai` direct to the Railway edge | phase 13 | | | | |
| `auth-staging.askansari.ai` via Cloudflare (once orange-clouded) | phase 13 | | | | |
| `auth-staging.askansari.ai` direct to the Railway edge | phase 13 | | | | |
| staging `*.up.railway.app` (backend, auth) | phase 13 | | | | |
| `api.askansari.ai` | window step 14 | | | | passive check before the merge (2026-10-17): no CNAME to Railway; A 104.21.29.181, 172.67.149.151, AAAA 2606:4700:3033::6815:1db5, 2606:4700:3031::ac43:9597 (Cloudflare); `curl -sI`: `server: cloudflare`, `cf-ray`, then `x-railway-edge: sin1`. **Cloudflare proxies in front of Railway's edge (measured).** What `X-Real-IP` carries on this path is not yet measured: see the finding below |
| `api-35.ansari.chat` | window step 14 | | | | passive check before the merge (2026-10-17): CNAME `vyex12qb.up.railway.app.` → 69.46.46.35; `curl -sI`: `server: railway-hikari`, `x-railway-edge: sjc1`, no proxy headers; same edge as staging |
| `auth.askansari.ai` | window step 11 | | | | passive check before the merge (2026-10-17): no DNS record yet. The record must exist, unattached, before the window (runbook step 1, spec H-5); it is attached in window step 11 |

**Verdict (the per-IP keys rest on it; no mode is selected):** _(recorded by phase 13)_

## Finding: `api.askansari.ai` is Cloudflare-proxied (2026-10-17; revised the same day)

**Measured:** Cloudflare sits in front of Railway's edge on `api.askansari.ai` (the passive check
above). Staging (`api-staging.askansari.ai`) and `api-35.ansari.chat` go straight to Railway.

**Withdrawn:** the first version of this finding said Railway's `X-Real-IP` on this domain is a
Cloudflare egress address, shared by every user, so the IP-keyed limits would act as global caps.
That was an **inference, not a measurement**, and it is most likely wrong. A sibling Railway
deployment measured the opposite on its own staging behind Cloudflare → Railway
(kidscanspell apps/auth, its issue 332):
- Railway's edge sets `x-real-ip` to the **true client** on both paths. When the peer is
  Cloudflare, the edge resolves `cf-connecting-ip` itself, and it discards a client-supplied
  `x-real-ip`.
- It rewrites `x-forwarded-for` to `peer, railway-edge`, so via Cloudflare the client is absent
  from that chain.
- Railway's edge is reachable directly with the `Host` header, and it passes a client-supplied
  `cf-connecting-ip` through verbatim. **`cf-connecting-ip` is therefore spoofable and is never
  trusted.**

That deployment keys on `x-real-ip` only, which is exactly our configuration
(`ipAddressHeaders: ['x-real-ip']` in packages/auth, `getRealIp` in apps/api), and it works behind
Cloudflare.

**Struck:** reading `CF-Connecting-IP` (even behind a Cloudflare-range check) is not an option,
because the direct path makes it spoofable. Turning Cloudflare off (DNS-only) is no longer
proposed.

**Open, as a measurement rather than a decision:** does `X-Real-IP` on our Cloudflare path carry
the true client? The method above measures it on staging via Cloudflare and direct, and the
in-window production probe (G-2) is the final word. If it does **not**, then since spec H-4 the
only keys affected are `apps/api`'s per-IP limits on the layer and the router's per-IP default on
`apps/auth` (the JWKS fetch and the paths no client of the layer reaches); every path the layer
calls is limited per email, per session token, per user or globally, whatever the edge does.
That outcome still goes back to the owner and the security architect.
