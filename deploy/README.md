# deploy/ — deployment targets & strategies (plan items 40, 41, 43, 44, 29)

The app is one portable Docker image (see `Dockerfile`, `docs/governance/04-GOVERNANCE.md` §17) and a
**verified-stateless app tier** — these files are how you run it. The current
plan is a **single Shinjiru dedicated box** (`VPS_UBUNTU_SETUP.md`); the rest
exist so a platform move is configuration, not a project.

## Going live — start at `../docs/GO_LIVE_RUNBOOK.md`
The ordered, non-coder runbook: a Shinjiru dedicated box, PostgreSQL as the
money authority from day one, the built-in manual (merchant) payment system, the
load test, and the Android app. It sequences `VPS_UBUNTU_SETUP.md` (below) and
the capacity docs for you.

## Single VPS (Ubuntu) — `VPS_UBUNTU_SETUP.md`
Everything on one Ubuntu 22.04/24.04 box: Node 22, PostgreSQL 18 as the single
replica set, PostgreSQL 18 + pgvector, Redis, MinIO, PM2 running the three
runtime roles, NGINX terminating TLS. Read its §0 before starting — four
properties of this codebase (the hard boot gate, mandatory object storage,
TLS-before-login, and `TRUST_PROXY`) each break a generic Node deployment in a
way that only shows up after you think you have finished.

## Kubernetes (item 40) — `k8s/deployment.yaml`
```
docker build -t <registry>/bettingbazaar:v1 . && docker push <registry>/bettingbazaar:v1
kubectl create secret generic bb-env --from-env-file=.env      # your real env
kubectl apply -f deploy/k8s/deployment.yaml                     # Deployment+Service+HPA
```
Statelessness prereqs are already met in code (JWT auth, Redis rate limits,
cron leader election, SSE/socket Redis bridge, S3 assets). Provide PostgreSQL
(replica set) + Redis reachable from the cluster. Ingress/TLS: use your
cluster's ingress controller in front of the `bettingbazaar` Service.

## Rolling deployment (item 44)
The manifest's `RollingUpdate {maxSurge:1, maxUnavailable:0}` IS rolling —
pods replace one-by-one with no capacity dip. On Railway: its native deploy is
**replace** (build → swap), not rolling; per the plan this is a platform
capability, so rolling on Railway = not available natively — use k8s (or any
platform with native rolling) when this matters.

## Blue/green (item 43)
Railway native support: none as a first-class primitive (checked per the plan's
"check native support first") — a manual approximation is two Railway services
behind your DNS. On k8s it's first-class with these manifests:
1. `kubectl apply` a second Deployment with `color: green` + the new image.
2. Verify green pods Ready (`kubectl get pods -l color=green`).
3. Flip the Service selector `color: blue → green` (instant cutover).
4. Rollback = flip the selector back. Delete blue when confident.

## Reproducible self-host / IaC (item 41) — `docker-compose.yml`
`docker compose -f deploy/docker-compose.yml up` stands up app + PostgreSQL
(single-node replica set, required for transactions) + Redis from scratch —
the version-controlled, reproducible environment definition. DECISION (recorded
in the deployment strategy): full Terraform/Pulumi only becomes worthwhile when
leaving Railway or provisioning multiple environments; `railway.json` +
this compose file + the k8s manifests cover reproducibility until then.

## Multi-domain (item 29) — Caddy pattern
The current Caddyfile serves `:{$PORT}` (host-agnostic — Railway terminates
TLS, so EVERY domain attached to the service already gets identical content;
adding a domain = Railway dashboard + DNS, zero code). If you instead run
Caddy yourself at the edge with automatic HTTPS, use one site block per domain,
same body:
```
bettingbazaar.com, bettingbazaar.vip {
    encode zstd gzip
    # ... identical handle blocks as the current Caddyfile ...
}
```
Caddy issues certs per domain automatically — after pointing DNS, verify BOTH
domains serve and pass the smoke tests (definition of done from the plan):
`curl -I https://<domain>/health` per domain, and `curl -I --http2` to confirm
HTTP/2. Canonical URL decision: set `CANONICAL_HOST` env (network.config.js)
to 301-normalize the non-canonical domains, or leave unset for equal peers.

## Core Infrastructure Architecture — HAProxy L4 template
`deploy/haproxy/core-infra-l4-passthrough.cfg` is a future licensed-operator
starting template for owned-service Layer-4 SNI passthrough with PROXY protocol
v2 client-IP preservation. It is not active in the default Railway deployment;
see `deploy/haproxy/README.md` before adapting it for a production edge.

## Grafana (item 34) — `grafana/bettingbazaar-dashboard.json`
Import into Grafana; point Prometheus at `GET /metrics` (Bearer METRICS_TOKEN
if set).
