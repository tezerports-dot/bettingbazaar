<!-- GOVERNANCE: Read CLAUDE.md before editing this file. -->
# deploy/vps/gateway

Put the offline-signed gateway document here as `gateway.json`. The app
containers mount this folder read-only at `/app/gateway` and serve the file at
`/api/v1/client/gateway-config` (and read its hosts for the standby pool).

Never put a private key here. See `docs/governance/DOMAIN_FAILOVER.md`.
