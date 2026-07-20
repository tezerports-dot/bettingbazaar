# HAProxy Core Infrastructure Architecture Template

This folder contains a safe starting template for the future licensed-operator
Core Infrastructure Architecture track recorded in `CAPABILITY_MATRIX_2026.md`.
It is deployment infrastructure, not application-domain code.

## What the template does

- Accepts TLS on port 443 without decrypting the application payload.
- Reads only the TLS ClientHello SNI value for Layer-4 routing.
- Routes only to explicitly owned backend services in the allow-list.
- Sends PROXY protocol v2 headers so trusted downstream services can recover the
  true client IP/source port without relying on spoofable public headers.
- Fails closed for malformed TLS or unmapped SNI.

## Operator TODO before production

1. Replace `*.example.com` with licensed operator-owned domains.
2. Replace `10.0.x.x` placeholders with private backend addresses.
3. Configure each downstream TLS service to accept PROXY protocol v2 only from
   the HAProxy tier or internal load balancer subnet.
4. Add health-check endpoints or TCP checks appropriate to each backend.
5. Document logs, incident response, rollback, topology ownership, and DNS change
   control before rollout.
6. Run compliance, provider-contract, abuse-monitoring, and trusted-proxy review.

## Validation examples

```bash
haproxy -c -f deploy/haproxy/core-infra-l4-passthrough.cfg
openssl s_client -connect <edge-ip>:443 -servername api.example.com
```

The Node/Express app in this repository already has `TRUST_PROXY` parsing for
standard reverse-proxy deployments. PROXY protocol v2 is lower-level than
`X-Forwarded-*`; if this template is used directly in front of Node, enable the
binary PROXY v2 TCP preface parser and pin it to the private HAProxy subnet:

```bash
PROXY_PROTOCOL_V2=true
PROXY_PROTOCOL_TRUSTED_SUBNETS=10.0.10.0/24
```

The backend fails closed when `PROXY_PROTOCOL_V2=true` but no trusted subnet is
configured. Do not include public client IP ranges in
`PROXY_PROTOCOL_TRUSTED_SUBNETS`; it must contain only internal HAProxy/LB source
subnets.
