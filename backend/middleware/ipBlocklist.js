// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ipBlocklist.js — refuse every request from an address an admin has blocked.
 *
 * ── Why this is rebuilt rather than restored ───────────────────────────────
 * The previous deny-list (`ipBlocker`) had a table and a repository and was
 * mounted NOWHERE: no request was ever checked, no route could block anything,
 * and three files said it "runs on every request" (F-030). This one is mounted
 * in server.js, has admin routes and a screen, and `ipBlocklistRoutesPg` proves
 * a blocked address is refused on a real route while a bystander is not.
 *
 * ── The list is in memory; the rows are the truth ──────────────────────────
 * A query per request would put the database on the path of every call,
 * blocked or not. So the live rows (`db.ipBlocks.liveBlocks()`) are loaded into
 * a `net.BlockList` — Node's own matcher for addresses and CIDR ranges, which
 * also matches an IPv4 block against the IPv4-mapped form `::ffff:a.b.c.d` that
 * `req.ip` takes without a proxy — and each request is one in-memory lookup.
 *
 *   - Loaded at BOOT, awaited, like the TLS policy: a server that cannot read
 *     the list does not start serving as if nothing were blocked.
 *   - Reloaded every REFRESH_MS, and at once on the instance where an admin
 *     changes it (`refreshIpBlocklistNow`). Other instances converge within
 *     REFRESH_MS — stated, not hidden: a block reaches a multi-instance fleet
 *     in at most ten seconds.
 *   - A FAILED reload keeps the last list that loaded, and says so loudly.
 *     Dropping to an empty list on a database blip would unblock every
 *     attacker at once, which is the expensive direction.
 *
 * ── Where it is mounted, and why there ─────────────────────────────────────
 * After the request logger (a refusal is logged) and BEFORE `securityMonitor`,
 * the load shedder and every rate limiter: a blocked address costs one lookup
 * and one log line. Mounted after `securityMonitor`, each refusal would write an
 * audit ROW — a blocked client hammering the API would be turned into database
 * writes, which is the opposite of blocking it.
 */
import net from 'node:net';
import { db } from '#db';

export const REFRESH_MS = 10_000;

let list = new net.BlockList();
let loadedAt = null;
let count = 0;
let timer = null;

/** Build a BlockList from rows whose `network` is CIDR text, e.g. 203.0.113.0/24. */
export function buildBlockList(networks) {
  const next = new net.BlockList();
  for (const cidr of networks) {
    const [address, bits] = String(cidr).split('/');
    const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    next.addSubnet(address, Number(bits ?? (family === 'ipv6' ? 128 : 32)), family);
  }
  return next;
}

/** Does this list cover the address? Never throws on a malformed address. */
export function listCovers(blockList, ip) {
  if (!ip || !net.isIP(String(ip))) return false;
  const addr = String(ip);
  return blockList.check(addr, net.isIPv6(addr) ? 'ipv6' : 'ipv4');
}

/** Reload from the rows. Throws on failure; the callers decide what that means. */
export async function refreshIpBlocklistNow() {
  const rows = await db.ipBlocks.liveBlocks();
  list = buildBlockList(rows.map((r) => r.network));
  count = rows.length;
  loadedAt = new Date();
  return { count, loadedAt };
}

/** Boot: load once (a failure fails startup), then keep reloading. */
export async function startIpBlocklistRefresh(everyMs = REFRESH_MS) {
  if (timer) return;
  await refreshIpBlocklistNow();
  timer = setInterval(() => {
    refreshIpBlocklistNow().catch((error) => {
      // Keep the last list that loaded — see the header.
      console.error(`[ip-blocklist] reload failed; still enforcing the ${count} block(s) loaded at ${loadedAt?.toISOString?.() ?? 'never'}:`, error.message);
    });
  }, everyMs);
  if (timer.unref) timer.unref();
}

/** What the admin screen shows about the enforcer itself. */
export function ipBlocklistStatus() {
  return { enforcing: true, blocks: count, loadedAt, refreshSeconds: REFRESH_MS / 1000 };
}

export function isBlocked(ip) {
  return listCovers(list, ip);
}

export function ipBlocklist(req, res, next) {
  if (!listCovers(list, req.ip)) return next();
  // The address is not echoed back and the reason is not disclosed: the person
  // reading this may be the one who was blocked.
  return res.status(403).json({
    success: false,
    code: 'IP_BLOCKED',
    message: 'Access from your network has been blocked. If you think this is a mistake, contact support.',
  });
}
