// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * config/apiHosts.js — the API hostnames an admin may point player apps at.
 *
 * Admin > Settings > API Host (`SystemConfig.apiHost`) chooses ONE of these;
 * `GET /api/v1/client/endpoint` serves the choice as `{"url": "https://host"}`,
 * which is what the player app's discovery step reads
 * (`user-panel/src/services/originFailover.ts`).
 *
 * The list is the deployment's, set in the environment and never in the
 * database: an admin picks among hosts the operator already serves, and no
 * saved setting can introduce a new one. The app holds its own build-time
 * allowlist (VITE_API_URL, VITE_API_BACKUP_URL, VITE_API_ALLOWED_HOSTS) and
 * refuses a discovered host outside it, so API_ALLOWED_HOSTS must be a subset
 * of that list (docs/governance/ENV.md).
 *
 *   API_ALLOWED_HOSTS   comma-separated exact hostnames (no scheme, port,
 *                       path, wildcard or IP address)
 */

/** An exact DNS hostname: at least two labels, letters, digits and hyphens. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True when `host` is a plain hostname (not a URL, wildcard or address). */
export function isPlainHostname(host) {
  return typeof host === 'string' && HOSTNAME.test(host) && !IPV4.test(host);
}

/**
 * Parse a comma-separated host list. An entry that is not a plain hostname is
 * dropped, never interpreted, and reported once so the operator sees it.
 */
export function parseApiHosts(raw) {
  const out = [];
  for (const entry of String(raw || '').split(',')) {
    const host = entry.trim().toLowerCase().replace(/\.$/, '');
    if (!host) continue;
    if (!isPlainHostname(host)) {
      console.warn(`[apiHosts] API_ALLOWED_HOSTS entry "${entry.trim()}" is not an exact hostname — ignored`);
      continue;
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/** The approved API hosts, in the order the operator listed them. */
export function approvedApiHosts() {
  return parseApiHosts(process.env.API_ALLOWED_HOSTS);
}

/**
 * The discovery answer for a stored choice: `https://<host>` when the choice is
 * still approved, '' otherwise (unset, or a host since removed from the list).
 */
export function apiOriginFor(choice, approved = approvedApiHosts()) {
  const host = String(choice || '').trim().toLowerCase();
  return host && approved.includes(host) ? `https://${host}` : '';
}
