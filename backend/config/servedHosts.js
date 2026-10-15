// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * config/servedHosts.js — every hostname this deployment may answer on.
 *
 * The union of what the operator already decided, and nothing a request or a
 * saved setting can add:
 *
 *   DOMAINS              the domains this deployment serves (network.config.js)
 *   ADMIN_HOST           the one name the admin panel answers on (network.config.js)
 *   API_ALLOWED_HOSTS    the API hosts an admin may point apps at (apiHosts.js)
 *   PUBLIC_APP_ORIGIN    the player site's host (publicAppOrigin.js)
 *   the signed gateway   every host of the document signed OFFLINE and served
 *   document             now (`servedGatewayHosts`, gatewayConfig.js), which is
 *                        where the STANDBY pool lives
 *
 * Two questions read it (docs/governance/DOMAIN_FAILOVER.md):
 *   - may the edge take a certificate for this name on first use
 *     (`GET /api/v1/client/tls-allowed`, Caddy's `on_demand_tls` ask), so a
 *     standby goes live with a DNS record and no edit or restart here;
 *   - may a browser on `https://<host>` call this API (CORS, server.js), so the
 *     player site opened on a standby, and an installed web app whose own
 *     address is a retired host of the pool, are not refused.
 * A retired host that is no longer in any of these keeps working only from
 * ALLOWED_ORIGINS, which is why the runbook says to leave it listed there.
 */
import { network } from './network.config.js';
import { approvedApiHosts, isPlainHostname } from './apiHosts.js';
import { publicAppOrigin } from './publicAppOrigin.js';
import { servedGatewayHosts } from '../domains/configuration/gatewayConfig.js';

function hostOfOrigin(origin) {
  try { return new URL(origin).hostname; } catch { return ''; }
}

/** Every hostname this deployment may serve, lowercase, no repeats. */
export async function servableHosts() {
  const listed = [
    ...network.domains.map((d) => d.toLowerCase().replace(/\.$/, '')),
    network.adminHost,
    ...approvedApiHosts(),
    hostOfOrigin(publicAppOrigin()),
    ...(await servedGatewayHosts()),
  ];
  return [...new Set(listed.filter(isPlainHostname))];
}

/** True when `host` is one of `servableHosts()`; exact match, never a pattern. */
export async function isServableHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return isPlainHostname(h) && (await servableHosts()).includes(h);
}

/**
 * True when a browser `Origin` is exactly `https://<servable host>`: no port,
 * no path, https only. Anything else is left to ALLOWED_ORIGINS.
 */
export async function isServableOrigin(origin) {
  let url;
  try { url = new URL(String(origin || '')); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  if (`${url.protocol}//${url.host}` !== origin) return false;
  return isServableHost(url.hostname);
}
