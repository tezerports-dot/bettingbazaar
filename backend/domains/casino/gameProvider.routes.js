// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * game-providers.routes.js
 *
 * Admin:  configure Evolution, Pragmatic, Spribe, Betby etc.
 * User:   GET provider status (is it live?) + POST launch (get iframe URL)
 * Webhook: provider wallet callbacks (bet/win/rollback)
 *
 * FLOW:
 *  1. Admin enables a provider and sets credentials in /api/admin/game-providers
 *  2. User opens Casino/Crash/Sports page → GET /api/game/providers → sees what's live
 *  3. User taps a game → POST /api/game/launch → backend creates player session with
 *     provider → returns {launchUrl} → frontend loads iframe fullscreen
 *  4. Provider calls our webhook on every bet/win → we debit/credit user wallet
 */
import express from 'express';
// Balances go to a third-party provider. They come from the wallet.
import { getBalances } from '../wallet/walletAuthority.service.js';
import { db } from '#db';
import crypto from 'crypto';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../identity/auth.middleware.js';
import { networkClient } from '../../services/networkClient.js';
import { verifyWebhookSignature } from './webhookSignature.js';
// Credentials are ciphertext in the row; they become usable only here.
import { sealCredential, openProviderSecrets } from './providerCredentials.js';

const router = express.Router();

// ── DEFAULT PROVIDER CATALOGUE (seeded on first access) ─────────────────────
const DEFAULT_PROVIDERS = [
  {
    key: 'evolution',
    name: 'Evolution Gaming',
    category: 'casino',
    description: 'World\'s leading live dealer casino — Roulette, Blackjack, Baccarat, Lightning Dice, Crazy Time and 80+ live tables.',
    logoUrl: '',
  },
  {
    key: 'pragmatic',
    name: 'Pragmatic Play',
    category: 'casino',
    description: 'Premium slots and live casino games — Gates of Olympus, Sweet Bonanza, live tables, and 300+ slot titles.',
    logoUrl: '',
  },
  {
    key: 'ezugi',
    name: 'Ezugi Live Casino',
    category: 'casino',
    description: 'India-focused live dealer games — Andar Bahar, Teen Patti, Lucky 7, Roulette and Blackjack with Indian dealers.',
    logoUrl: '',
  },
  {
    key: 'spribe',
    name: 'Spribe — Aviator',
    category: 'crash',
    description: 'Aviator: the world\'s most played crash game. Watch the multiplier rise — cash out before the plane flies away.',
    logoUrl: '',
  },
  {
    key: 'smartsoft',
    name: 'Smartsoft — JetX',
    category: 'crash',
    description: 'JetX crash game plus Plinko, Penalty Shoot-Out, Balloon, and other instant-win titles.',
    logoUrl: '',
  },
  {
    key: 'betby',
    name: 'Betby Sportsbook',
    category: 'sports',
    description: 'Full sportsbook — Cricket, Football, Basketball, Tennis, Kabaddi, live in-play betting with 125+ sports markets.',
    logoUrl: '',
  },
];

/**
 * Register the providers the platform knows about.
 *
 * The upsert deliberately does NOT carry credentials, and `upsertProvider`
 * treats a null credential as "unchanged" — so running this on every request,
 * as the routes below do, cannot wipe an API key an admin configured.
 */
async function seedProviders() {
  for (const p of DEFAULT_PROVIDERS) {
    await db.games.upsertProvider({
      providerKey: p.key, name: p.name, category: p.category,
      description: p.description, logoUrl: p.logoUrl,
    });
  }
}

// ── PUBLIC: what providers are active for each category ─────────────────────

// GET /api/game/providers — called by user panel on page load
router.get('/providers', async (req, res) => {
  try {
    await seedProviders();
    // The public reader selects five columns and none of them is a credential
    // — an API secret in a public response is published however it is labelled,
    // and so, more quietly, is the fact that a switched-off supplier already
    // has keys loaded. Only enabled providers come back, so the lobby cannot
    // render a tile that refuses to launch.
    const providers = await db.games.listPublicProviders();
    const grouped = { casino: [], crash: [], sports: [] };
    for (const p of providers) {
      if (grouped[p.category]) grouped[p.category].push(p);
    }
    res.json({ success: true, providers: grouped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PLAYER: launch a game session ───────────────────────────────────────────

// POST /api/game/launch
// Body: { providerKey, gameId?, gameName?, mode? }
router.post('/launch', authenticate, async (req, res) => {
  try {
    const { providerKey, gameId = '', gameName = '', mode = 'real' } = req.body;

    const listed = await db.games.getProvider(providerKey);
    if (!listed?.enabled) {
      return res.status(400).json({ success: false, message: 'This game provider is not available yet' });
    }
    // The credentials, asked for by name — this is the one place that signs a
    // launch, and the only reason to read them. They come out of the row as
    // ciphertext and are opened here; signing with the stored value directly
    // produces a signature every provider rejects.
    const provider = { ...listed, ...openProviderSecrets(await db.games.getProviderSecrets(providerKey)) };
    if (!provider.apiKey || !provider.apiUrl) {
      return res.status(400).json({ success: false, message: 'Provider is not fully configured' });
    }
    // Named to the provider. Read here rather than assumed: the handler used to
    // reference a `user` that no longer existed in scope, which threw on every
    // Evolution launch — the one provider path that sends a player name.
    const player = await db.users.getUser(String(req.user.userId));
    if (!player) return res.status(404).json({ success: false, message: 'Account not found' });

    // From the WALLET. This is the balance handed to a third-party provider as
    // the player's starting figure — a zero here does not merely display
    // wrong, it tells the provider the player cannot stake anything.
    const balances = await getBalances(String(req.user.userId));
    const balance = (balances.depositBalance || 0) + (balances.winningsBalance || 0);
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 4 * 3600000); // 4h

    let launchUrl = '';

    // ── Evolution Gaming launch ──────────────────────────────────────────────
    if (providerKey === 'evolution') {
      // POST to Evolution auth endpoint to get game launch URL
      // Real endpoint: {apiUrl}/api/auth  with HMAC-SHA256 signed body
      const timestamp  = Date.now();
      const signature  = crypto.createHmac('sha256', provider.apiSecret)
        .update(`${provider.merchantId}${req.user.userId}${timestamp}`)
        .digest('hex');
      try {
        const body = {
          uuid:      sessionId,
          player: {
            id:       String(req.user.userId),
            update:   true,
            firstName: player.username || 'Player',
            lastName:  '',
            currency:  'INR',
            session:  { id: sessionId, ip: req.ip || '0.0.0.0' },
          },
          config: {
            game:     { category: provider.extraConfig?.lobby || 'LIVE_CASINO' },
            brand:    { id: provider.merchantId },
          },
        };
        const resp = await networkClient.request(`${provider.apiUrl}/api/ecashier/ams/v1/auth`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Operator-Id': provider.merchantId,
            'X-Signature':   signature,
            'X-Timestamp':   String(timestamp),
          },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        launchUrl = data.entry || data.entryEmbedded || '';
      } catch (e) {
        console.error('Evolution launch error:', e.message);
      }
    }

    // ── Spribe (Aviator) launch ──────────────────────────────────────────────
    else if (providerKey === 'spribe') {
      const token = crypto.createHmac('sha256', provider.apiSecret)
        .update(`${req.user.userId}:${sessionId}:${Date.now()}`)
        .digest('hex');
      launchUrl = `${provider.apiUrl}/launch/${gameId || 'aviator'}?operatorId=${provider.merchantId}&token=${token}&currency=INR&lang=en&userId=${req.user.userId}&returnUrl=${encodeURIComponent(process.env.APP_BASE_URL || '')}`;
    }

    // ── Betby Sports launch ──────────────────────────────────────────────────
    else if (providerKey === 'betby') {
      const token = Buffer.from(JSON.stringify({
        userId: String(req.user.userId),
        balance,
        currency: 'INR',
        sessionId,
        ts: Date.now(),
      })).toString('base64');
      launchUrl = `${provider.apiUrl}/sportsbook?brandId=${provider.merchantId}&token=${token}&lang=en&currency=INR`;
    }

    // ── Pragmatic Play launch ────────────────────────────────────────────────
    else if (providerKey === 'pragmatic') {
      const hash = crypto.createHash('md5')
        .update(`${req.user.userId}${provider.apiSecret}`)
        .digest('hex');
      launchUrl = `${provider.apiUrl}/gs2c/do?token=${hash}&stylename=${provider.merchantId}&game=${gameId || 'vs20sugardance'}&jurisdiction=INR&lobby_url=${encodeURIComponent(process.env.APP_BASE_URL || '')}`;
    }

    // ── Ezugi launch ─────────────────────────────────────────────────────────
    else if (providerKey === 'ezugi') {
      const token = crypto.createHmac('sha256', provider.apiSecret)
        .update(`${provider.merchantId}${req.user.userId}${Date.now()}`)
        .digest('hex');
      launchUrl = `${provider.apiUrl}/ezglaunch?operatorId=${provider.merchantId}&token=${token}&gameId=${gameId || '1'}&lang=en&currency=INR`;
    }

    // ── Smartsoft (JetX) launch ───────────────────────────────────────────────
    else if (providerKey === 'smartsoft') {
      launchUrl = `${provider.apiUrl}/${gameId || 'JetX'}?token=${sessionId}&currency=INR&lang=en&operatorId=${provider.merchantId}`;
    }

    // The session is recorded only once there is a URL to record. It used to
    // be written first and the failure checked after, so a provider whose
    // credentials were wrong left a live session for a game that never opened
    // — and a callback arriving against it would have been honoured.
    if (!launchUrl) {
      return res.status(500).json({ success: false, message: 'Could not generate game launch URL. Check provider credentials.' });
    }

    await db.games.openSession({
      sessionId, userId: req.user.userId, providerKey, gameId, gameName,
      launchUrl, ttlMinutes: 240,
    });

    res.json({ success: true, launchUrl, sessionId });
  } catch (err) {
    console.error('Game launch error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── WALLET WEBHOOK — provider calls this on every bet / win / rollback ───────
// Mounted at POST /api/game/wallet/:providerKey
//
// This route carries no `authenticate` middleware: the caller is a game
// supplier, not a signed-in player. The HMAC below is therefore the ONLY thing
// between the open internet and a wallet movement, and everything after it runs
// on the supplier's word.
//
// ── One decision, in one transaction ────────────────────────────────────────
// The handler used to read the balance, compare it to the stake, and then debit
// — a check two concurrent callbacks both pass — and to sum a round's prior
// transactions in JavaScript before allowing a rollback, which two rollbacks
// carrying different provider ids both pass. `applyProviderCallback` makes the
// round's running totals move under the round's row lock inside the same
// transaction as the money, with `refunded_paise <= debited_paise` as a CHECK
// constraint underneath. There is no branch here that can get it wrong,
// because there is no branch here.
router.post('/wallet/:providerKey', async (req, res) => {
  try {
    const { providerKey } = req.params;

    // Only the webhook secret is read, and only to verify the signature.
    const secrets = await db.games.getProviderSecrets(providerKey);
    if (!secrets) return res.status(404).json({ success: false });

    const verdict = verifyWebhookSignature(openProviderSecrets(secrets).webhookSecret, req.headers, req.body);
    if (!verdict.ok) return res.status(verdict.status).json({ success: false, message: verdict.message });

    // Normalise the payload — every supplier spells these differently.
    const body    = req.body || {};
    const txId    = body.transactionId || body.txId || body.uuid || body.transaction_id;
    const userId  = body.playerId || body.player_id || body.userId;
    const type    = body.type || body.action || '';
    const amount  = Math.abs(Number(body.amount ?? body.bet ?? 0));
    const roundId = body.roundId || body.round_id || body.gameRound || txId;
    const gameId  = body.gameId || body.game_id || '';

    if (!txId || !userId || !type || !(amount > 0)) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    // The balance recorded as `balanceBefore` on the audit row. A read, not a
    // gate: the gate is the wallet's own row lock, one call below.
    const balanceBefore = await db.casino.spendableBalance(userId);

    // ── The whole decision ───────────────────────────────────────────────────
    // Idempotency included: a redelivered callback collides on `tx_id` INSIDE
    // the transaction and comes back `idempotent`, rather than being screened
    // out by a prior read that a concurrent redelivery would pass.
    const applied = await db.casino.applyProviderCallback({
      txId, roundId, userId, type, amountRupees: amount,
      providerKey, gameId,
      reason: `Casino ${String(type).toUpperCase()}: ${gameId} round ${roundId}`,
    });

    if (!applied.ok) {
      const message = {
        no_prior_debit:       'No prior debit for this round',
        refund_exceeds_debit: 'Refund exceeds the amount debited for this round',
        insufficient:         'Insufficient balance',
        unknown_type:         'Unrecognised transaction type',
        invalid_amount:       'Invalid amount',
      }[applied.reason] || `Callback refused: ${applied.reason}`;
      console.error(`[casino] refusing ${type} for round ${roundId}: ${applied.reason}`);
      // A refusal is 400 with the balance attached: suppliers reconcile against
      // it, and one told nothing retries the same refused callback for hours.
      return res.status(400).json({
        success: false, message, balance: await db.casino.spendableBalance(userId),
      });
    }

    // The provider-facing record of the callback. Keyed on the supplier's own
    // id, so a redelivery records once — and written AFTER the money moved, so
    // a row here always has a ledger row behind it.
    await db.games.recordGameTransaction({
      txId, roundId, sessionId: body.sessionId || null, userId,
      providerKey, txType: db.casino.normaliseType(type), amountRupees: amount,
      balanceBeforeRupees: balanceBefore, balanceAfterRupees: applied.balanceRupees,
      gameId, gameName: body.gameName || null,
    });

    res.json({ success: true, balance: applied.balanceRupees, currency: 'INR' });
  } catch (err) {
    console.error('Wallet webhook error:', err);
    res.status(500).json({ success: false, message: 'Callback could not be processed.' });
  }
});

// ── ADMIN: CRUD for provider config ─────────────────────────────────────────
//
// No handler below reads a credential. `listProviders` does not select them and
// reports only WHETHER each is set; the update writes them without reading them
// back; the connectivity test asks for the secrets by name, uses them, and
// returns a verdict. An operator screen therefore cannot leak a key it never
// received, which is a stronger guarantee than masking one it did.

// GET /api/admin/game-providers
router.get('/admin/game-providers', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    await seedProviders();
    res.json({ success: true, providers: await db.games.listProviders() });
  } catch (err) {
    console.error('GET /admin/game-providers error:', err);
    res.status(500).json({ success: false, message: 'Could not load providers.' });
  }
});

/**
 * PUT /api/admin/game-providers/:key — edit a provider.
 *
 * A credential key that is absent from the body leaves the stored one alone; an
 * explicit empty string clears it. The form shows `hasApiKey`, never the key,
 * so "unchanged" is the only thing a re-submitted form can mean.
 */
router.put('/admin/game-providers/:key', authenticate, isAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['name', 'category', 'enabled', 'apiUrl', 'providerMerchantId',
      'extraConfig', 'logoUrl', 'description']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    // Accepted under their plain names from the form; stored in the encrypted
    // columns. The mapping is explicit so a new form field cannot arrive in a
    // credential column by matching a name.
    if (b.apiKey !== undefined) patch.apiKeyEncrypted = b.apiKey === '' ? null : sealCredential(b.apiKey);
    if (b.apiSecret !== undefined) patch.apiSecretEncrypted = b.apiSecret === '' ? null : sealCredential(b.apiSecret);
    if (b.webhookSecret !== undefined) patch.webhookSecretEncrypted = b.webhookSecret === '' ? null : sealCredential(b.webhookSecret);

    const provider = await db.games.updateProvider(req.params.key, patch, { updatedBy: req.user.userId });
    if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });

    // Who changed a payment-facing integration, and which fields — without the
    // values, because an audit log is not a place to put an API secret.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'GAME_PROVIDER_UPDATED', category: 'CONFIG',
      targetType: 'GameProvider', targetId: provider.key,
      details: { fields: Object.keys(patch), enabled: provider.enabled },
    });
    res.json({ success: true, provider });
  } catch (err) {
    // An enabled provider with no endpoint is refused by the row, not by a
    // branch here — the constraint holds for every writer, including a script.
    if (err.code === '23514') {
      return res.status(400).json({ success: false, message: 'A provider cannot be enabled without an API URL.' });
    }
    console.error('PUT /admin/game-providers error:', err);
    res.status(500).json({ success: false, message: 'Could not update that provider.' });
  }
});

/**
 * POST /api/admin/game-providers/:key/test — is the endpoint reachable?
 *
 * The credentials are fetched by name and stay in this function. The response
 * says reachable or not and why; it never echoes what it authenticated with.
 */
router.post('/admin/game-providers/:key/test', authenticate, isAdmin, async (req, res) => {
  try {
    const provider = await db.games.getProvider(req.params.key);
    if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });

    const secrets = openProviderSecrets(await db.games.getProviderSecrets(req.params.key));
    if (!secrets?.apiUrl || !secrets?.apiKey) {
      return res.status(400).json({ success: false, message: 'API URL and API Key are required to test' });
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    try {
      await networkClient.request(secrets.apiUrl, { method: 'HEAD', signal: ctrl.signal });
      res.json({ success: true, message: `✓ ${provider.name} endpoint is reachable` });
    } catch (e) {
      res.json({ success: false, message: `✗ Could not reach ${secrets.apiUrl}: ${e.message}` });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error('POST /admin/game-providers/:key/test error:', err);
    res.status(500).json({ success: false, message: 'Could not run that test.' });
  }
});

// GET /api/admin/game-transactions — provider callback history
router.get('/admin/game-transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { providerKey, userId, txType, page = 1, limit = 30 } = req.query;
    // The page and its total come back from one query, so the footer count and
    // the rows below it describe the same instant.
    const result = await db.games.adminGameTransactions({ providerKey, userId, txType, page, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('GET /admin/game-transactions error:', err);
    res.status(500).json({ success: false, message: 'Could not load transactions.' });
  }
});

/**
 * POST /api/admin/game-providers — register a new provider.
 *
 * Created disabled: enabling happens after the credentials are entered and the
 * test passes, which is a second, deliberate action.
 */
router.post('/admin/game-providers', authenticate, isAdmin, async (req, res) => {
  try {
    const { key, name, category, description, logoUrl, apiUrl,
      apiKey, apiSecret, merchantId, webhookSecret, extraConfig } = req.body || {};
    if (!key || !name || !category) {
      return res.status(400).json({ success: false, message: 'key, name, and category are required' });
    }
    const slug = String(key).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!slug) return res.status(400).json({ success: false, message: 'key must contain a letter or digit' });

    // The key decides. Two admins submitting the same name at once get one
    // provider and one 409, never a silent overwrite of the other's credentials.
    const provider = await db.games.createProvider({
      providerKey: slug, name: String(name).trim(), category,
      description: description || '', logoUrl: logoUrl || null, apiUrl: apiUrl || null,
      apiKeyEncrypted: sealCredential(apiKey),
      apiSecretEncrypted: sealCredential(apiSecret),
      webhookSecretEncrypted: sealCredential(webhookSecret),
      providerMerchantId: merchantId || null, extraConfig: extraConfig || {},
      updatedBy: req.user.userId,
    });
    if (!provider) return res.status(409).json({ success: false, message: `Provider "${slug}" already exists` });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'GAME_PROVIDER_CREATED', category: 'CONFIG',
      targetType: 'GameProvider', targetId: provider.key,
      details: { name: provider.name, category: provider.category },
    });
    res.json({ success: true, provider });
  } catch (err) {
    console.error('POST /admin/game-providers error:', err);
    res.status(500).json({ success: false, message: 'Could not create that provider.' });
  }
});

/**
 * DELETE /api/admin/game-providers/:key
 *
 * Refused while games still point at it. Deleting the provider under a live
 * tile leaves a lobby entry that fails at the click, and the player is the one
 * who discovers it.
 */
router.delete('/admin/game-providers/:key', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await db.games.deleteProvider(req.params.key);
    if (!result.ok && result.reason === 'NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Provider not found' });
    }
    if (!result.ok) {
      return res.status(409).json({
        success: false,
        message: `${result.games} game${result.games === 1 ? '' : 's'} still use this provider. Remove or reassign them first.`,
      });
    }
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'GAME_PROVIDER_DELETED', category: 'CONFIG',
      targetType: 'GameProvider', targetId: req.params.key,
      details: { name: result.name },
    });
    res.json({ success: true, message: `${result.name} deleted` });
  } catch (err) {
    console.error('DELETE /admin/game-providers error:', err);
    res.status(500).json({ success: false, message: 'Could not delete that provider.' });
  }
});

export default router;
