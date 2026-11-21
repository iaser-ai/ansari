# Edge check: is `X-Real-IP` the client's address? (spec 300, plan P-4)

`apps/auth` keys the router's per-IP default on `X-Real-IP` (`advanced.ipAddress.ipAddressHeaders`),
and `apps/api` keys its per-IP limits on the `/v2/users` layer's routes on the same header. No
path the layer calls is keyed by IP on `apps/auth` (spec H-4), and nothing forwards the header
between the services any more. Both per-IP keys are only sound if Railway's edge **overwrites**
`X-Real-IP` with the real client address on every domain, and gives different clients different
addresses. This file holds the method and the recorded observations. The verdict selects no mode
(`AUTH_RATE_LIMIT_MODE` is removed, H-4); a failure goes to the security architect (window step
12's abort).

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

On each path, over IPv4 and over IPv6 where reachable, run the probe with the client-IP headers
forged (`<probe>` is the route above for that service). **Via Cloudflare, forge only `X-Real-IP`
and `X-Forwarded-For`; direct, forge all three.** A request that carries a client-supplied
`CF-Connecting-IP` through a Cloudflare-proxied hostname is refused by Cloudflare itself, HTTP
`403` with the body `error code: 1000` (measured 2026-11-21 on `api.askansari.ai` and
`auth.askansari.ai`; the finding below), so with it the probe never reaches Railway:

```bash
FORGED_CF=(-H 'X-Real-IP: 192.0.2.66' -H 'X-Forwarded-For: 192.0.2.66')
FORGED=(-H 'X-Real-IP: 192.0.2.66' -H 'X-Forwarded-For: 192.0.2.66' -H 'CF-Connecting-IP: 192.0.2.66')
URL=https://<domain>/<probe>

# Via Cloudflare (the orange-clouded hostname resolves to Cloudflare), each family forced:
curl -4 -s "${FORGED_CF[@]}" "$URL"
curl -6 -s "${FORGED_CF[@]}" "$URL"     # Cloudflare publishes AAAA

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

> **2026-11-21, the window's measurements and the shapes file.** The probe JSON measured in
> production (Observations below) matches the two provisional `probe` objects in
> [`edge-header-shapes.json`](edge-header-shapes.json) field for field. The file is **not**
> changed: the probes report the `X-Forwarded-For` entry count and whether the first entry is
> `x_real_ip`, never the entries' values, so the `headers` of each shape (for example
> `x-forwarded-for: 198.51.100.10, 192.0.2.200` via Cloudflare) are not determined by them. Also,
> the via-Cloudflare shape is named for all three headers forged, and through Cloudflare only two
> can be (the 403 below). Replacing the shapes still needs a header capture on each path.

**Pre-merge passive check of each production domain** (no code deployed): record the `dig` chain
and the `curl -sI` headers, which show whether Cloudflare is in front.

The **in-window production probe** (G-2, window steps 11 and 12: the auth domain's in step 11,
after step 10) runs the same two paths on the production domains and stays the
final word. In production the auth domain is not attached at step 9: it is already attached and
served by `auth`'s existing deployment (owner's decision, 2026-11-21;
[`release-record.md`](release-record.md)), until step 10's push deploys `auth` from `main`. On
staging, step 9 attaches it.

## Observations (phase 13 and the window)

| Domain | When | IPv4 overwrite | IPv6 overwrite | Distinct | Notes |
|---|---|---|---|---|---|
| `api-staging.askansari.ai` via Cloudflare (once orange-clouded) | phase 13 | | | | |
| `api-staging.askansari.ai` direct to the Railway edge | phase 13 | | | | |
| `auth-staging.askansari.ai` via Cloudflare (once orange-clouded) | phase 13 | | | | |
| `auth-staging.askansari.ai` direct to the Railway edge | phase 13 | | | | |
| staging `*.up.railway.app` (backend, auth) | phase 13 | | | | |
| `api.askansari.ai` via Cloudflare | window step 12 | **PASS** | not measured: the operator network had no IPv6 | not measured: needs a second network (owed by the owner) | **2026-11-21, ~11:28Z, from the owner's network, IPv4** (measured by the security architect; 203.0.113.10 = the real client, per [`edge-header-shapes.json`](edge-header-shapes.json)): `X-Real-IP` and `X-Forwarded-For` forged: `200`, `{x_real_ip: 203.0.113.10, x_forwarded_for_entries: 2, x_forwarded_for_first_is_x_real_ip: false, cf_connecting_ip: 203.0.113.10, via_cloudflare: true}`. With `CF-Connecting-IP` forged too, Cloudflare answers `403`, `error code: 1000` (the finding below). Earlier, passive check before the merge (2026-10-17): no CNAME to Railway; A 104.21.29.181, 172.67.149.151, AAAA 2606:4700:3033::6815:1db5, 2606:4700:3031::ac43:9597 (Cloudflare); `curl -sI`: `server: cloudflare`, `cf-ray`, then `x-railway-edge: sin1`. **Cloudflare proxies in front of Railway's edge (measured).** |
| `api.askansari.ai` direct to the Railway edge | window step 12 | **PASS** | not measured: the operator network had no IPv6; no AAAA for the direct path | not measured: needs a second network (owed by the owner) | **2026-11-21, ~11:28Z, from the owner's network, IPv4** (measured by the security architect; 203.0.113.10 = the real client, per [`edge-header-shapes.json`](edge-header-shapes.json)): `--resolve` to `vyex12qb.up.railway.app`'s A record, all three forged: `200`, `{x_real_ip: 203.0.113.10, x_forwarded_for_entries: 2, x_forwarded_for_first_is_x_real_ip: true, cf_connecting_ip: 192.0.2.66, via_cloudflare: false}` |
| `api-35.ansari.chat` direct | window step 12 | **PASS** | not measured: the operator network had no IPv6; no AAAA for the direct path | not measured: needs a second network (owed by the owner) | **2026-11-21, ~11:28Z, from the owner's network, IPv4** (measured by the security architect; 203.0.113.10 = the real client, per [`edge-header-shapes.json`](edge-header-shapes.json)): all three forged: `200`, `{x_real_ip: 203.0.113.10, x_forwarded_for_entries: 2, x_forwarded_for_first_is_x_real_ip: true, cf_connecting_ip: 192.0.2.66, via_cloudflare: false}`. Earlier, passive check before the merge (2026-10-17): CNAME `vyex12qb.up.railway.app.` → 69.46.46.35; `curl -sI`: `server: railway-hikari`, `x-railway-edge: sjc1`, no proxy headers; same edge as staging |
| `auth.askansari.ai` via Cloudflare | window step 11 | **PASS** | not measured: the operator network had no IPv6 | not measured: needs a second network (owed by the owner) | **2026-11-21, ~11:28Z, from the owner's network, IPv4** (measured by the security architect; 203.0.113.10 = the real client, per [`edge-header-shapes.json`](edge-header-shapes.json)): `X-Real-IP` and `X-Forwarded-For` forged: `200`, `{x_real_ip: 203.0.113.10, x_forwarded_for_entries: 2, x_forwarded_for_first_is_x_real_ip: false, cf_connecting_ip: 203.0.113.10, via_cloudflare: true}`. **Cloudflare-proxied** (`server: cloudflare`, `cf-ray`, `x-railway-edge: sin1`); with `CF-Connecting-IP` forged, `403`, `error code: 1000`. Before: the passive check before the merge (2026-10-17) found no DNS record yet; on 2026-11-21, before the window, it was attached and serving (`/health` 200, measured by the architect; [`release-record.md`](release-record.md)), kept by the owner's decision (window step 9 skips the attach in production). Step 10's push redeployed `auth` from `main` (success 11:23:18Z) before this probe |
| `auth.askansari.ai` direct to the Railway edge | window step 11 | not measured: its `*.up.railway.app` name was not at hand | not measured: no IPv6 on the operator network | not measured: needs a second network (owed by the owner) | owed |

**Verdict (the per-IP keys rest on it; no mode is selected):** _(recorded by phase 13)_

**Production verdict (window step 12, 2026-11-21):** the security architect decided that the
window goes on. **Overwrite passes on every measured path**: `x_real_ip` was the real client, never
`192.0.2.66`, via Cloudflare and direct, on `api.askansari.ai`, `api-35.ansari.chat` and
`auth.askansari.ai` (via Cloudflare). **Open:** distinctness on every path (a second network, owed
by the owner), IPv6 on every path, and `auth.askansari.ai` direct to the Railway edge. The staging
rows above stay blank (the rehearsal precondition was waived; [`release-record.md`](release-record.md)).

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

**Answered in the window (2026-11-21):** on `api.askansari.ai`'s and `auth.askansari.ai`'s
Cloudflare path, `X-Real-IP` carried the true client, and a forged one was discarded
(Observations above). Distinctness is still to be measured.

## Finding: Cloudflare refuses a client-supplied `CF-Connecting-IP` (2026-11-21)

**Measured** by the security architect in the window, on `api.askansari.ai` and
`auth.askansari.ai`: a request through Cloudflare that carries a client-supplied
`CF-Connecting-IP` gets HTTP `403` with the body `error code: 1000` from Cloudflare itself; it never
reaches Railway's edge or the service. So through Cloudflare a client **cannot even present** a
forged `CF-Connecting-IP`. The method above therefore forges only `X-Real-IP` and
`X-Forwarded-For` on the via-Cloudflare path, and all three on the direct path, where Railway
passes a forged `CF-Connecting-IP` through verbatim (`cf_connecting_ip: 192.0.2.66`, Observations).
Nothing changes in what the services trust: they key on `X-Real-IP` only, and `CF-Connecting-IP`
stays untrusted because the direct path exists.
