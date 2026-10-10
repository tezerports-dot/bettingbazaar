# Regional failover runbook — keeping one domain up when an origin region fails

This is disaster-recovery routing for a **single, unchanging public domain per
brand**. If an origin server or a whole region goes offline, traffic shifts to a
standby origin **behind the same domain**. The hostname a player visits never
changes, so there is nothing to re-issue, re-point, or tell players about.

What this runbook is **not**: it is not a pool of public domains, it does not
mint or rotate domains, and it does not broadcast a "current domain" to players
or marketing systems. One brand, one domain; redundancy lives behind it. A
design that changes the player-facing URL on an outage is out of scope here on
purpose (it is domain rotation, not failover).

The pieces this uses already exist in the repo:

- **Origin pool + health checks:** `deploy/haproxy/core-infra-l4-passthrough.cfg`
  routes each owned SNI to a backend with an active and a standby origin and TCP
  health checks (`default-server inter 5s fall 3 rise 2`). HAProxy stops sending
  to a server after 3 failed checks and resumes after 2 good ones.
- **Application readiness:** `GET /health` and `/api/v1/health` (and
  `/health/ready`) run a real `SELECT 1` against the money database and answer
  `503` when it is unreachable or the instance is draining
  (`readinessState()` in `backend/server.js`). A node whose database is gone
  takes itself out of rotation; the load balancer does not have to guess.
- **Liveness:** `/health/live` is process-only and answers `503` only while
  draining, so an orchestrator restarts a crashed process but not one that is
  deliberately shutting down.

---

## Topology

```
          player → https://app.<brand> (one A/AAAA record, never changes)
                                │
                        ┌───────┴────────┐
                        │   edge (TLS)   │   region A  ── primary
                        │  HAProxy L4    │
                        └───────┬────────┘
                   health-checked TCP, PROXY v2
                 ┌─────────────┴──────────────┐
          app_node_1 (region A)        app_node_2 (region B)  ── standby
          api_node_1  (region A)        api_node_2  (region B)
```

Each backend in the HAProxy config is one such pool. `balance source` keeps a
given client on one origin while it is healthy; when it fails its checks,
HAProxy moves that traffic to the standby in the other region. Same domain, same
certificate, different origin.

---

## Health-driven failover (the automatic path)

No action needed — this is what the running system does on its own:

1. An origin in region A stops answering. Its TCP check fails `fall` (3) times
   over ~15 s, or its `/health` goes `503` because its database is gone.
2. HAProxy marks that server `DOWN` and sends new connections to the region-B
   standby in the same backend.
3. When region A recovers, its checks pass `rise` (2) times and HAProxy returns
   it to rotation.

Confirm from the edge host:

```bash
# Server states and check results
echo "show servers state" | socat stdio /run/haproxy/admin.sock

# The app's own readiness on each origin (expect 200 healthy / 503 unhealthy)
curl -sS -o /dev/null -w '%{http_code}\n' https://<origin-ip>/health --resolve app.<brand>:443:<origin-ip>
```

---

## Promoting a standby manually (planned maintenance)

When you are taking region A down on purpose, drain it rather than letting the
health check catch up:

```bash
# Drain region A's app origin: finish in-flight connections, accept no new ones
echo "set server app_tls_backend/app_node_1 state drain" | socat stdio /run/haproxy/admin.sock

# Watch it empty, then take it fully out
echo "set server app_tls_backend/app_node_1 state maint"  | socat stdio /run/haproxy/admin.sock
```

Repeat per backend (`api_tls_backend`, `identity_tls_backend`). Bring it back:

```bash
echo "set server app_tls_backend/app_node_1 state ready" | socat stdio /run/haproxy/admin.sock
```

Enabling the runtime API: uncomment the `stats socket` line in the config's
`global` section (it is commented by default).

---

## If the whole edge region is gone

A single HAProxy edge is itself a single point of failure. Run a second edge in
another region and let **DNS answer with a healthy edge for the same hostname** —
the hostname stays `app.<brand>`; only which edge IP it resolves to changes:

- **Anycast / provider health-checked DNS:** point `app.<brand>` at both edge
  IPs and let the DNS provider (or an anycast address) withdraw the dead one.
  Keep the record TTL low (30–60 s) so withdrawal is quick. This is a health
  check on an existing record, not a new domain.
- **Manual:** if you must flip by hand, change the A/AAAA record of the existing
  hostname to the surviving edge. Still the same domain; still the same cert
  (use a cert valid at both edges, or per-edge certs for the same name).

Do **not** stand up a different public hostname and route players to it. That is
not covered here.

---

## DNS and certificates (one-time setup)

- One canonical hostname per brand (`app.<brand>`, and `api.<brand>` only if the
  app fetches from a distinct API host — see CLAUDE.md §2 "The API host player
  apps are sent to"). These are owned, licensed-operator domains.
- A/AAAA records point at the edge(s). If Cloudflare-proxied, origins accept
  traffic only from Cloudflare + your edge (`deploy/vps/harden-origin-firewall.sh`,
  `deploy/vps/EDGE_ORIGIN_HARDENING.md`).
- Certificates cover the canonical hostname and are present at every edge that
  can answer for it.
- Record all of the above under change control, per the HAProxy README's
  operator TODO.

---

## Rollback

- A promotion or drain is reversed with `state ready` (above); nothing persists
  across an HAProxy reload unless you also edited the config file.
- A config edit (adding/removing an origin) is validated and reloaded:

  ```bash
  haproxy -c -f deploy/haproxy/core-infra-l4-passthrough.cfg   # validate first
  systemctl reload haproxy                                     # reload, no dropped conns
  ```

- A DNS change is rolled back by restoring the previous record; the low TTL that
  made failover fast also makes the rollback fast.

---

## What to check quarterly (CLAUDE.md §17.3)

- Kill the primary origin in staging and confirm HAProxy fails over within
  `inter × fall` (~15 s) and players see no domain change.
- Confirm `/health` goes `503` when its database is stopped, and that the origin
  leaves rotation as a result.
- Confirm the standby origin is actually in a different failure domain (region,
  power, network) from the primary — two servers in one rack is not failover.
