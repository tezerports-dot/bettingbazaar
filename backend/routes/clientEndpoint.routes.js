// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * GET /api/v1/client/endpoint — the player app's endpoint discovery answer.
 *
 * Answers `{"url": "https://<host>"}` with the host chosen in Admin > Settings >
 * API Host (`SystemConfig.apiHost`), and only while that host is still on the
 * deployment's approved list (`backend/config/apiHosts.js`). With no choice, or
 * a choice since removed from the list, it answers 404 and the app falls back
 * to its configured primary and backups (`originFailover.ts`).
 *
 * Public and unauthenticated: the app asks before it knows where to sign in.
 * It carries nothing secret — a hostname the app already holds on its own
 * build-time allowlist — and the app validates the answer against that list
 * regardless of what this says. Point VITE_API_DISCOVERY_URL at this route on
 * every host (or a copy of its answer on a static host), so discovery itself
 * does not depend on one origin.
 */
import express from 'express';
import { db } from '#db';
import { apiOriginFor } from '../config/apiHosts.js';
import { servedGatewayDocument } from '../domains/configuration/gatewayConfig.js';
import { serverError } from '../shared/httpError.js';
import { isServableHost } from '../config/servedHosts.js';
import { miniAppBot, miniAppEntryLink } from '../domains/telegram/telegramClient.js';

/** How long a client or cache may reuse the answer. A change of host reaches apps within this. */
export const ENDPOINT_MAX_AGE_SECONDS = 60;

const router = express.Router();

router.get('/v1/client/endpoint', async (req, res) => {
  try {
    const { apiHost } = await db.config.getSystemConfig();
    const url = apiOriginFor(apiHost);
    res.set('Cache-Control', `public, max-age=${ENDPOINT_MAX_AGE_SECONDS}`);
    if (!url) return res.status(404).json({ success: false, code: 'NO_API_HOST', message: 'No API host is chosen' });
    return res.json({ url });
  } catch (err) {
    return serverError(res, err, 'client endpoint');
  }
});

/**
 * GET /api/v1/client/gateway-config — the operator's offline-signed gateway
 * document (`domains/configuration/gatewayConfig.js`), served as it was
 * signed. 404 when none is configured or it no longer verifies. The app
 * verifies it against its build-time key whatever this route says, so any
 * mirror of the file is as good as this one.
 */
router.get('/v1/client/gateway-config', async (req, res) => {
  try {
    const text = await servedGatewayDocument();
    res.set('Cache-Control', `public, max-age=${ENDPOINT_MAX_AGE_SECONDS}`);
    if (!text) return res.status(404).json({ success: false, code: 'NO_GATEWAY_CONFIG', message: 'No signed gateway document is served' });
    return res.type('application/json').send(text);
  } catch (err) {
    return serverError(res, err, 'client gateway config');
  }
});

/**
 * GET /api/v1/client/telegram-entry — the Telegram link that always opens the
 * player app's way in (`miniAppEntryLink`): `{"url": "https://t.me/…"}`, or
 * 404 with no bot saved. The app remembers it, and its "Can't connect" screen
 * and its Invite screen show it, so a player whose site address was blocked
 * still has a way back (docs/governance/DOMAIN_FAILOVER.md).
 */
router.get('/v1/client/telegram-entry', async (req, res) => {
  try {
    const url = miniAppEntryLink(await miniAppBot());
    res.set('Cache-Control', `public, max-age=${ENDPOINT_MAX_AGE_SECONDS}`);
    if (!url) return res.status(404).json({ success: false, code: 'TELEGRAM_UNAVAILABLE', message: 'Telegram is not set up yet' });
    return res.json({ url });
  } catch (err) {
    return serverError(res, err, 'client telegram entry');
  }
});

/**
 * GET /api/v1/client/tls-allowed?domain=<host> — the edge's question before it
 * takes a certificate for a name on first use (Caddy's `on_demand_tls` `ask`,
 * deploy/vps/Caddyfile.vps). 200 when the host is one this deployment serves
 * (`servableHosts`: DOMAINS, the API hosts, the player site, the signed
 * document's standby pool), 404 otherwise, so a standby goes live when its DNS
 * points here, and a stranger's name pointed at this address gets nothing.
 * Public because the edge asks over the internal network the same way a
 * stranger would; it reveals no more than the signed document already lists.
 */
router.get('/v1/client/tls-allowed', async (req, res) => {
  try {
    const ok = await isServableHost(typeof req.query.domain === 'string' ? req.query.domain : '');
    res.set('Cache-Control', 'no-store');
    if (!ok) return res.status(404).json({ success: false, code: 'NOT_SERVED_HERE', message: 'This host is not served here' });
    return res.json({ success: true });
  } catch (err) {
    return serverError(res, err, 'client tls allowed');
  }
});

export default router;
