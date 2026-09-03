#!/usr/bin/env bash
# GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
# ═════════════════════════════════════════════════════════════════════════════
# Lock the ORIGIN (Shinjiru) firewall to: WireGuard-from-the-edge + SSH-from-you.
#
# After this runs, the origin drops ALL inbound public traffic except:
#   • WireGuard (UDP 51820) from the edge's public IP only
#   • SSH (TCP 22)          from your management IP only
#   • anything arriving over the wg0 tunnel interface (that IS the edge)
#   • loopback (the databases live here and must never be public)
#
# Public HTTPS is terminated at the EDGE, not here — so this box deliberately
# does NOT open 80/443 to the world. That is the point: the origin has no public
# web port to attack, scan, or discover.
#
# ── The lockout risk, and the net under it ──────────────────────────────────
# A firewall that denies your own SSH is the classic way to lose a box. This
# script schedules `ufw disable` in 10 minutes via `at` BEFORE it locks down.
# If you can still SSH in afterwards, cancel the net (the script prints how). If
# you get locked out, wait 10 minutes and the rules roll back on their own.
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   sudo EDGE_PUBLIC_IP=203.0.113.10 MGMT_IP=198.51.100.7 ./harden-origin-firewall.sh
#
# MGMT_IP should be a STABLE address you control — an office/VPN egress, not a
# café. If your admin IP changes, you will lock yourself out at the next change;
# prefer reaching SSH over the tunnel or a bastion instead (see the runbook).
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${EDGE_PUBLIC_IP:?set EDGE_PUBLIC_IP to the edge public IP (the WireGuard peer)}"
: "${MGMT_IP:?set MGMT_IP to your admin/VPN IP (SSH is allowed from here only)}"
WG_PORT="${WG_PORT:-51820}"
SSH_PORT="${SSH_PORT:-22}"

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
command -v ufw >/dev/null || { echo "ufw not installed: apt install -y ufw" >&2; exit 1; }

echo "This will RESET the firewall on this origin box and allow only:"
echo "  • WireGuard  UDP/$WG_PORT   from  $EDGE_PUBLIC_IP  (the edge)"
echo "  • SSH        TCP/$SSH_PORT  from  $MGMT_IP         (you)"
echo "  • traffic arriving on the wg0 tunnel, and loopback"
echo "  • NO public 80/443 — the edge terminates TLS, not this box"
read -r -p "Proceed? [y/N] " ok; [[ ${ok,,} == y ]] || { echo "Aborted."; exit 0; }

# ── Safety net: roll the rules back in 10 minutes unless you cancel ──────────
SAFETY_JOB=""
if command -v at >/dev/null; then
  SAFETY_JOB=$(echo "ufw --force disable" | at now + 10 minutes 2>&1 | awk '/job/{print $2}')
  echo "Safety net armed: ufw disables itself in 10 minutes. at job: ${SAFETY_JOB:-unknown}"
else
  echo "WARNING: 'at' is not installed, so there is NO automatic rollback."
  echo "         apt install -y at   — or keep a second SSH session open before continuing."
  read -r -p "Continue without a safety net? [y/N] " ok2; [[ ${ok2,,} == y ]] || { echo "Aborted."; exit 0; }
fi

# ── Rules ────────────────────────────────────────────────────────────────────
ufw --force reset
ufw default deny incoming
ufw default allow outgoing            # the app dials out to nothing untrusted; egress stays open

# SSH from your management IP only. Added BEFORE enable, so the tunnel that
# carries this very session survives the switch.
ufw allow from "$MGMT_IP" to any port "$SSH_PORT" proto tcp comment 'ssh: mgmt only'

# WireGuard from the edge only. This is the sole public service on the origin.
ufw allow from "$EDGE_PUBLIC_IP" to any port "$WG_PORT" proto udp comment 'wireguard: edge only'

# Everything the edge sends arrives on wg0 once the tunnel is up. The app binds
# to the tunnel address (10.10.0.2), so this is how it is reached.
ufw allow in on wg0 comment 'app traffic over the tunnel'

# Loopback is where Postgres/Redis/MinIO listen (VPS_UBUNTU_SETUP §11).
# They must never be reachable from anywhere else, tunnel included.
ufw allow in on lo

ufw --force enable
echo
ufw status verbose

cat <<EOF

────────────────────────────────────────────────────────────────────────────
Applied. NOW, from a SECOND terminal, confirm you can still SSH in:

    ssh -p $SSH_PORT <you>@<this-origin>

If that works, cancel the rollback so the rules stick:
EOF
if [[ -n "$SAFETY_JOB" ]]; then
  echo "    sudo atrm $SAFETY_JOB"
else
  echo "    (no safety job was scheduled — nothing to cancel)"
fi
cat <<'EOF'

Then verify the origin has NO public web port. From anywhere OTHER than the
edge, both of these must hang or refuse — never connect:

    nc -vz -w5 <this-origin-public-ip> 443
    nc -vz -w5 <this-origin-public-ip> 80

If either connects, something is still binding a public port — find it with
`ss -tlnp` and stop it. The origin should answer only on 10.10.0.2 (the tunnel)
and 127.0.0.1 (the databases).
────────────────────────────────────────────────────────────────────────────
EOF
