// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ipBlocks.admin.routes.js — Admin › Blocked IPs.
 *
 *   GET  /security/ip-blocks                    live blocks (?includeReleased=1 for history)
 *   POST /security/ip-blocks                    { network, reason, expiresInMinutes? }
 *   POST /security/ip-blocks/:blockId/release   lift one; the row is kept
 *
 * Admin only — this refuses every request from a range, players and merchants
 * included, and it is not a permission to hand a sub-admin by default.
 *
 * ── The refusals, each for a mistake that locks the wrong people out ──────
 *   - A range wider than /16 (IPv4) or /48 (IPv6). Most Indian mobile traffic
 *     sits behind carrier-grade NAT, where one address is already many players;
 *     a /8 is a region. A range that wide is a mistake more often than a defence.
 *   - Loopback and the unspecified address: blocking them stops the platform's
 *     own health checks and in-process callers.
 *   - Any range that covers the requesting admin's OWN address. Without this an
 *     admin behind a misconfigured proxy (TRUST_PROXY unset, so every request
 *     appears to come from the balancer) blocks the balancer — everybody,
 *     themselves included — and cannot reach this screen to undo it.
 * Each refusal is a 400 naming the problem (§32 S35).
 */
import net from 'node:net';
import { db } from '#db';
import { express, authenticate, hasPermission } from './_adminShared.js';
import { respondError } from '../../shared/httpError.js';
import { buildBlockList, listCovers, refreshIpBlocklistNow, ipBlocklistStatus } from '../../middleware/ipBlocklist.js';

const router = express.Router();

const MIN_PREFIX = { ipv4: 16, ipv6: 48 };
/** ::ffff:0:0/96 — every IPv4 address, spelled as IPv6. */
const MAPPED_SPACE = buildBlockList(['::ffff:0:0/96']);
const MAX_EXPIRY_MINUTES = 60 * 24 * 365;

const refuse = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Parse and judge a requested range. Returns the canonical text the database
 * will store, or throws a 400 naming what is wrong with it.
 */
export function judgeNetwork(input, requesterIp) {
  const text = String(input ?? '').trim();
  if (!text) throw refuse('Enter an IP address or a range, e.g. 203.0.113.7 or 203.0.113.0/24.');
  const [address, bitsText, extra] = text.split('/');
  if (extra !== undefined || !net.isIP(address)) {
    throw refuse(`"${text}" is not an IP address or a CIDR range. Use a form like 203.0.113.7 or 203.0.113.0/24.`);
  }
  const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
  const max = family === 'ipv6' ? 128 : 32;
  const bits = bitsText === undefined ? max : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) {
    throw refuse(`The range size must be a whole number from 0 to ${max} for an ${family === 'ipv6' ? 'IPv6' : 'IPv4'} address.`);
  }
  if (bits < MIN_PREFIX[family]) {
    throw refuse(`/${bits} is too broad to block. The widest allowed is /${MIN_PREFIX[family]} for ${family === 'ipv6' ? 'IPv6' : 'IPv4'}: behind mobile carrier NAT a single address is already many players.`);
  }
  const probe = buildBlockList([`${address}/${bits}`]);
  // ── An IPv4 range in IPv6 spelling is an IPv4 range ────────────────────────
  // `::ffff:10.0.0.0/104` is IPv4 10.0.0.0/8, and Node's matcher applies it to
  // plain IPv4 clients too. Judged as IPv6 it cleared the /48 floor, so the
  // /16 rule was one respelling away from blocking a region (2026-10-01). Any
  // range that reaches the IPv4-mapped space is held to the IPv4 floor, in
  // IPv4 terms: its own width past the 96-bit mapped prefix, or all of IPv4
  // when it is wider than that prefix and contains it.
  if (family === 'ipv6') {
    const v4Bits = listCovers(MAPPED_SPACE, address) ? bits - 96
      : bits < 96 && listCovers(probe, '::ffff:0:0') ? 0
        : null;
    if (v4Bits !== null && v4Bits < MIN_PREFIX.ipv4) {
      throw refuse(`/${bits} written in IPv6 form covers an IPv4 /${Math.max(v4Bits, 0)}, which is too broad to block. The widest allowed is /${MIN_PREFIX.ipv4} for IPv4 (/${96 + MIN_PREFIX.ipv4} in the ::ffff: form): behind mobile carrier NAT a single address is already many players.`);
    }
  }
  if (['127.0.0.1', '::1', '0.0.0.0', '::'].some((a) => listCovers(probe, a))) {
    throw refuse('Loopback and unspecified addresses cannot be blocked — that would stop the platform\'s own health checks.');
  }
  if (listCovers(probe, requesterIp)) {
    throw refuse('This range includes the address you are using right now, so it would lock you out of this screen. If every request appears to come from one address, the server\'s TRUST_PROXY setting is probably wrong.');
  }
  return `${address}/${bits}`;
}

router.get('/security/ip-blocks', authenticate, hasPermission('canManageIpBlocks'), async (req, res) => {
  try {
    const includeReleased = req.query.includeReleased === '1' || req.query.includeReleased === 'true';
    const blocks = await db.ipBlocks.listBlocks({ includeReleased });
    res.json({ success: true, blocks, enforcer: ipBlocklistStatus(), yourIp: req.ip ?? null });
  } catch (error) {
    return respondError(res, error, 'GET /admin/security/ip-blocks', { message: 'Failed to load blocked IPs' });
  }
});

router.post('/security/ip-blocks', authenticate, hasPermission('canManageIpBlocks'), async (req, res) => {
  try {
    const network = judgeNetwork(req.body?.network, req.ip);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw refuse('A reason is required — it is what an appeal is answered from.');
    if (reason.length > 500) throw refuse('Keep the reason under 500 characters.');
    // A DURATION, not a date: the database dates it, on the same clock its
    // CHECK uses (see blockNetwork). This route used to add it to its own
    // clock, and a server running behind the database refused short blocks.
    let expiresInMinutes = null;
    const minutes = req.body?.expiresInMinutes;
    if (minutes !== undefined && minutes !== null && minutes !== '') {
      const m = Number(minutes);
      if (!Number.isInteger(m) || m < 1 || m > MAX_EXPIRY_MINUTES) {
        throw refuse(`Expiry must be a whole number of minutes from 1 to ${MAX_EXPIRY_MINUTES}, or empty for a block that lasts until it is lifted.`);
      }
      expiresInMinutes = m;
    }

    const block = await db.ipBlocks.blockNetwork({ network, reason, actor: req.user.userId, expiresInMinutes });
    // This instance enforces it at once; the others within the refresh interval.
    await refreshIpBlocklistNow().catch((e) => console.error('[ip-blocklist] immediate reload failed:', e.message));
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'IP_BLOCKED', category: 'SECURITY',
      targetType: 'ip_block', targetId: block.blockId, targetName: block.network,
      details: { network: block.network, reason, expiresAt: block.expiresAt },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.status(201).json({ success: true, block });
  } catch (error) {
    return respondError(res, error, 'POST /admin/security/ip-blocks', { message: 'Failed to block that address' });
  }
});

router.post('/security/ip-blocks/:blockId/release', authenticate, hasPermission('canManageIpBlocks'), async (req, res) => {
  try {
    const block = await db.ipBlocks.releaseBlock({ blockId: req.params.blockId, actor: req.user.userId });
    if (!block) return res.status(404).json({ success: false, message: 'That block does not exist.' });
    await refreshIpBlocklistNow().catch((e) => console.error('[ip-blocklist] immediate reload failed:', e.message));
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'IP_UNBLOCKED', category: 'SECURITY',
      targetType: 'ip_block', targetId: block.blockId, targetName: block.network,
      details: { network: block.network },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.json({ success: true, block });
  } catch (error) {
    return respondError(res, error, 'POST /admin/security/ip-blocks/:blockId/release', { message: 'Failed to lift that block' });
  }
});

export default router;
