# Edge / origin hardening — hiding the origin behind a scrubbing edge

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

Splits the single-VPS deployment (`../VPS_UBUNTU_SETUP.md`) into two tiers: a
disposable **edge** with a clean public IP that absorbs the internet, and the
**origin** — your Shinjiru box holding the app, the databases and the market
engine — reachable only through an encrypted tunnel from the edge. The origin
serves no public web port at all, so it cannot be scanned, hit, or discovered by
address.

> **This is an engineering runbook, not a licence.** Same caveat as every
> deployment doc here: a real-money launch needs a gambling licence, an AML/KYC
> programme and a third-party pen test first
> (`docs/governance/LAUNCH_READINESS.md` §G). Infrastructure does not change what
> is legal where you operate.

---

## Scope — what this builds, and the one thing it does not

| Asked for | Here | How |
|---|---|---|
| **A.** Reverse proxy / edge CDN | ✅ | Cloudflare in front of a Caddy edge (steps 4–5) |
| **C.** Internal tunnel (WireGuard) | ✅ | edge ↔ origin, the only path in (steps 1, 4) |
| **D.** Layer-7 DDoS protection | ✅ | Cloudflare WAF + rate rules, on top of the app's own IP defense (step 5) |
| Origin firewall lockdown | ✅ | `harden-origin-firewall.sh` (step 3) |
| **B.** Automatic domain rotation *when blocked* | ❌ | see below |

**On B.** Static multi-domain is already supported and is the right tool for
redundancy: every hostname in `SITE_ADDRESS` serves the same app with no
per-domain logic and no client IP/geo/ISP input, a constraint that is deliberate
and load-bearing (`04-GOVERNANCE.md` §20). What is *not* included is a controller
that detects a domain being blocked and swaps in a fresh one automatically. That
component exists to defeat blocking orders rather than to defend against
attackers, and it is out of scope for this runbook. Everything else here hardens
the service against attack, which is ordinary security engineering — that
distinction is the whole reason the rest is here.

---

## The shape

```
[ User / PWA / App ]
        │  HTTPS
        ▼
[ Cloudflare ]  proxied DNS · WAF · L7 rate limiting · Under-Attack toggle
        │  HTTPS (origin-pull mTLS)      ← Cloudflare only reaches the edge
        ▼
[ Edge VPS ]  clean public IP · Caddy terminates TLS · no app, no data
        │  WireGuard (10.10.0.0/24)      ← the only way to the origin
        ▼
[ Origin — Shinjiru, Malaysia ]  app (3 roles) · Mongo/PG/Redis/MinIO · market engine
     no public web port · firewall drops everything but the tunnel + your SSH
```

Two independent moves make the origin unreachable except through the app:

1. **The edge holds no secrets and no data.** If it is DDoSed, blacklisted or
   seized, you rebuild it in minutes from these files and a new IP; the origin
   and its databases never move and were never exposed.
2. **The origin's address is written in exactly one place** — the edge's
   WireGuard peer config, a root-only file — and never in DNS. Cloudflare hides
   the edge; the tunnel hides the origin.

---

## Prerequisites

- The origin already provisioned per `../VPS_UBUNTU_SETUP.md` (app + datastores
  running, datastores on loopback).
- A second small VPS for the edge, with a clean public IP, `80`/`443` reachable.
- A domain on Cloudflare (or an equivalent proxying CDN with a WAF).
- `wireguard` installed on both boxes: `apt install -y wireguard`.
- A stable management IP for SSH to the origin (an office/VPN egress). If you do
  not have one, plan to reach the origin's SSH *over the tunnel* instead — see
  the note in step 3.

---

## 1. Origin: bring up the tunnel

On the origin, generate its keypair and write the interface:

```bash
umask 077
wg genkey | tee /etc/wireguard/origin.private | wg pubkey > /etc/wireguard/origin.public
```

Copy `deploy/vps/wireguard/origin.wg0.conf.example` to `/etc/wireguard/wg0.conf`,
paste in `origin.private`, and leave the edge's public key for step 4 (you will
have it once the edge keypair exists). Then:

```bash
systemctl enable --now wg-quick@wg0
wg show          # interface up, listening on 51820
ip -brief addr show wg0   # 10.10.0.2/32
```

## 2. Origin: keep the app on the tunnel, the data on loopback

The app binds `0.0.0.0` (`backend/server.js`), so it is the **firewall** in step
3 — not the bind address — that makes its ports private. Nothing about the app
changes here; just confirm the datastores never left loopback:

```bash
ss -tlnp | grep -E '27017|5432|6379|9000'   # every line must show 127.0.0.1
```

If any datastore shows `0.0.0.0`, fix that before opening the tunnel — the tunnel
would otherwise reach it. (Mongo/PG/Redis/MinIO binding is covered in
`../VPS_UBUNTU_SETUP.md` §§3–6.)

If you run PROXY protocol from an L4 edge instead of Caddy's HTTP forwarding, set
`PROXY_PROTOCOL_V2_ENABLED` and `PROXY_PROTOCOL_V2_TRUSTED_SUBNETS` to the tunnel
subnet so the real client IP survives (`config/network.config.js`). With the
Caddy edge in step 4 you do not need this — Caddy forwards the IP in a header and
step 6 handles it.

## 3. Origin: lock the firewall

`deploy/vps/harden-origin-firewall.sh` drops **all** inbound except WireGuard
from the edge, SSH from your management IP, the tunnel interface, and loopback.
It arms a 10-minute auto-rollback first, so a mistake un-does itself rather than
locking you out.

```bash
sudo EDGE_PUBLIC_IP=<edge public IP> MGMT_IP=<your admin IP> \
  deploy/vps/harden-origin-firewall.sh
```

Then, from another terminal, confirm SSH still works and cancel the rollback (the
script prints the exact `atrm` command). This box now opens **no** `80`/`443` to
the public internet — that is the point, and it is the difference from the
single-VPS firewall in `../VPS_UBUNTU_SETUP.md` §11.

> **No stable management IP?** Do not widen SSH to the world to compensate. Bring
> the tunnel up first, then allow SSH only on `wg0` (reach the origin at
> `10.10.0.2` from the edge, or run a small bastion on the edge). Edit the script's
> SSH rule to `allow in on wg0 to any port 22` and drop the `MGMT_IP` rule.

## 4. Edge: tunnel + reverse proxy

On the edge, generate its keypair, fill
`deploy/vps/wireguard/edge.wg0.conf.example` (it needs the origin's **public key**
from step 1 and the origin's real `IP:51820` as the `Endpoint`), and complete the
origin's `[Peer]` block with the edge's public key. Bring both ends up; `wg show`
on each should show a handshake and, after a ping, transferred bytes:

```bash
ping -c3 10.10.0.2      # from the edge — the origin answers over the tunnel
```

Install Caddy on the edge and use `deploy/vps/Caddyfile.edge`, which proxies to
the origin's tunnel address (`10.10.0.2`). Set `SITE_ADDRESS` to your hostname(s)
and `ACME_EMAIL`.

**Recommended: mTLS from edge to origin.** WireGuard already encrypts the hop;
requiring a client certificate makes the origin reject anything inside the tunnel
that is not this edge. The app already supports it — set `BACKEND_MTLS_CERT`,
`BACKEND_MTLS_KEY`, `BACKEND_MTLS_CA` on the origin (it then demands a client
cert) and the matching `tls_client_auth` lines in `Caddyfile.edge`
(`backend/server.js` wires both; the env is in `docs/governance/ENV.md`).

## 5. Cloudflare: the L7 scrubbing layer (D)

Point the hostname's DNS at the **edge** IP, **proxied** (orange cloud) so the
edge IP is never public either. Then:

- **SSL/TLS mode: Full (strict).** Caddy on the edge has a real certificate, so
  strict verification works and prevents a downgrade.
- **Authenticated Origin Pulls** (mTLS Cloudflare → edge): the edge accepts HTTPS
  only from Cloudflare, so nobody who learns the edge IP can bypass the WAF by
  hitting it directly. Belt to the firewall's braces below.
- **Edge firewall:** allow `443`/`80` inbound **only** from Cloudflare's
  published IP ranges; deny the rest. (`ufw allow from <cf-range> to any port 443
  proto tcp`, repeated per range; automate from Cloudflare's IP list.)
- **WAF:** enable the managed ruleset. Add rate-limiting rules on the sensitive
  paths — `/api/*/login`, `/api/user/*/kyc`, `/api/bet/*` — as an outer bound
  above the app's own per-IP limiters and `ipDefense` subnet backstop.
- **Bot Fight / "I'm Under Attack" mode:** keep the toggle handy; under a real L7
  flood it challenges every client at the edge before traffic ever reaches the
  tunnel.

The app is not relying on Cloudflare for correctness — its own rate limiters,
`ipDefense`, TLS-fingerprint defense and Turnstile still run at the origin. This
layer is the volumetric/L7 scrubbing in front, so the origin spends no CPU on
traffic that never should have arrived.

## 6. The one app-config change: real client IP through two hops

There are now two proxies in front of the app (Cloudflare, then the edge Caddy),
where the single-VPS setup had one. `TRUST_PROXY=1` would make `req.ip` the
edge's tunnel address for **every** user — pooling all per-IP controls (rate
limits, `ipDefense`, audit logs, bans) into one shared budget, so four bad
passwords from anyone lock out login for everyone (`../VPS_UBUNTU_SETUP.md` §0.4).

Set it to the hop count:

```ini
TRUST_PROXY=2      # Cloudflare + edge Caddy
```

Never `TRUST_PROXY=true` — that trusts a client-supplied `X-Forwarded-For` and
lets anyone forge their IP, defeating every control listed above
(`docs/governance/ENV.md` §1; there is a test that this fails closed:
`securityReviewFixes.test.js`).

## 7. Verify — end to end, and that the origin is actually dark

```bash
# 1. Public reaches the app THROUGH the whole chain:
curl -sI https://yourdomain.com/            # 200, served via Cloudflare → edge → tunnel

# 2. The origin refuses direct traffic. From anywhere that is NOT the edge, both
#    must hang or refuse — never connect:
nc -vz -w5 <origin-public-ip> 443
nc -vz -w5 <origin-public-ip> 80

# 3. The edge refuses non-Cloudflare traffic (origin-pull mTLS + IP allowlist):
curl -sI https://<edge-public-ip>/ --resolve yourdomain.com:443:<edge-public-ip>
#    → handshake refused / 403, not 200

# 4. The real client IP survives. Log in, then confirm YOUR ip — not 10.10.0.1 —
#    appears in the app logs. If it is the tunnel address, TRUST_PROXY is wrong (§6).

# 5. WebSocket + SSE survive the extra hop: open the player app and watch a cycle
#    tick; open the admin panel and confirm the SSE stream holds past 60 seconds.
```

Checks 2 and 3 are the ones that prove the architecture rather than just the
happy path — that the origin is dark and the edge is Cloudflare-only. Run them
from a network that is neither.

---

## Honest limits

- **The edge is a single point for availability.** One edge box is one failure
  domain for reachability (the origin and its data are safe, but the site is
  down). Run two edges behind Cloudflare load balancing, each with its own tunnel
  to the origin, before you depend on this.
- **The tunnel is a dependency.** If `wg0` drops, the edge cannot reach the app.
  `PersistentKeepalive` and `systemctl enable wg-quick@wg0` cover restarts;
  monitor the handshake age (`wg show`) and alert on it.
- **Cloudflare sees plaintext.** Terminating TLS at Cloudflare means it can read
  traffic. That is inherent to any CDN-in-front model; if it is unacceptable for
  your threat model, use an L4 (spectrum/pass-through) edge and terminate TLS on
  your own edge box instead — the tunnel and firewall steps are unchanged.
- **This hides the origin from scanning and casual discovery. It is not
  anonymity.** Payment rails, the licence, DNS registration and business
  relationships identify an operator regardless of where the box sits.

---

**See also:** `../VPS_UBUNTU_SETUP.md` (the origin build) ·
`Caddyfile.edge` · `wireguard/*.conf.example` · `harden-origin-firewall.sh` ·
`deploy/haproxy/core-infra-l4-passthrough.cfg` (L4 edge alternative) ·
`docs/governance/ENV.md` (`TRUST_PROXY`, backend mTLS, PROXY protocol).
