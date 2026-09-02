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
import { debitForGameProviderBet, creditWinnings, refundOrder } from '../wallet/walletAuthority.service.js';
// Domain 9's resolver. When Postgres owns the path the round's running totals
// move under its row lock in the SAME transaction as the wallet movement, and
// the refund bound is a CHECK CONSTRAINT rather than a read-then-compare.
import { applyCallbackOnPostgres } from '#db/repositories/casino.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../identity/auth.middleware.js';
import { networkClient } from '../../services/networkClient.js';
import { verifyWebhookSignature } from './webhookSignature.js';

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

async function seedProviders() {
  const GameProvider = mongoose.model('GameProvider');
  for (const p of DEFAULT_PROVIDERS) {
    await GameProvider.findOneAndUpdate({ key: p.key }, p, { upsert: true, setDefaultsOnInsert: true });
  }
}

// ── PUBLIC: what providers are active for each category ─────────────────────

// GET /api/game/providers — called by user panel on page load
router.get('/providers', async (req, res) => {
  try {
    const GameProvider = mongoose.model('GameProvider');
    await seedProviders();
    const providers = await GameProvider.find()
      .select('key name category enabled description logoUrl')
      .lean();
    // Group by category
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
    const GameProvider = mongoose.model('GameProvider');
    const GameSession  = mongoose.model('GameSession');
    const User         = mongoose.model('User');

    const provider = await GameProvider.findOne({ key: providerKey });
    if (!provider?.enabled) {
      return res.status(400).json({ success: false, message: 'This game provider is not available yet' });
    }
    if (!provider.apiKey || !provider.apiUrl) {
      return res.status(400).json({ success: false, message: 'Provider is not fully configured' });
    }

    const user = await User.findById(req.user.userId).select('username mobile depositBalance winningsBalance');
    const balance = (user.depositBalance || 0) + (user.winningsBalance || 0);
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
            firstName: user.username || 'Player',
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

    // Save session
    await GameSession.create({
      sessionId,
      userId:      req.user.userId,
      providerKey,
      gameId,
      gameName,
      launchUrl,
      expiresAt,
    });

    if (!launchUrl) {
      return res.status(500).json({ success: false, message: 'Could not generate game launch URL. Check provider credentials.' });
    }

    res.json({ success: true, launchUrl, sessionId });
  } catch (err) {
    console.error('Game launch error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── WALLET WEBHOOK — provider calls this on every bet / win / rollback ───────
// Mounted at POST /api/game/wallet/:providerKey
// Each provider has a different payload format; we normalise before processing.
router.post('/wallet/:providerKey', async (req, res) => {
  try {
    const { providerKey } = req.params;
    const GameProvider    = mongoose.model('GameProvider');
    const GameTransaction = mongoose.model('GameTransaction');
    const User            = mongoose.model('User');

    const provider = await GameProvider.findOne({ key: providerKey });
    if (!provider) return res.status(404).json({ success: false });

    const verdict = verifyWebhookSignature(provider.webhookSecret, req.headers, req.body);
    if (!verdict.ok) return res.status(verdict.status).json({ success: false, message: verdict.message });

    // Normalise payload across providers
    const body = req.body;
    const txId    = body.transactionId || body.txId || body.uuid || body.transaction_id;
    const userId  = body.playerId || body.player_id || body.userId;
    const type    = (body.type || body.action || '').toUpperCase().replace('DEBIT', 'BET').replace('CREDIT', 'WIN');
    const amount  = Math.abs(Number(body.amount || body.bet || 0));
    const roundId = body.roundId || body.round_id || body.gameRound || txId;
    const gameId  = body.gameId || body.game_id || '';

    if (!txId || !userId || !amount || !type) return res.status(400).json({ success: false, message: 'Missing fields' });

    // Idempotency — reject duplicate txId
    const dup = await GameTransaction.findOne({ txId });
    if (dup) {
      // `.lean()` yields null for a since-deleted player; dereferencing it here
      // turned a benign replay into a 500.
      const prior = await User.findById(dup.userId).lean();
      return res.json({ success: true, balance: prior?.depositBalance || 0 });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'Player not found' });

    const balance = (user.depositBalance || 0) + (user.winningsBalance || 0);

    // ── The resolver, asked once ─────────────────────────────────────────
    // Returns handled:false while Mongo owns the path, and the branch below
    // runs unchanged. When Postgres owns it, a REFUSAL IS SURFACED to the
    // provider rather than retried against Mongo — in this domain the refusal
    // is the product: it is what stops a buggy or hostile provider minting
    // money by rolling back a round that never had a bet.
    const routed = await applyCallbackOnPostgres({
      txId, roundId, userId, type, amountRupees: amount,
      providerKey, gameId,
      reason: `Casino ${type}: ${gameId} round ${roundId}`,
    });
    if (routed.handled) {
      if (!routed.ok) {
        const message = routed.reason === 'no_prior_debit'
          ? 'No prior debit for this round'
          : routed.reason === 'refund_exceeds_debit'
            ? 'Refund exceeds the amount debited for this round'
            : `Callback refused: ${routed.reason}`;
        console.error(`[casino] refusing ${type} for round ${roundId}: ${routed.reason}`);
        return res.status(400).json({ success: false, message });
      }
      // The GameTransaction document is written by the reverse mirror, so the
      // record exists in both stores without this route writing it twice.
      return res.json({ success: true, balance: routed.balanceRupees, currency: 'INR' });
    }

    if (type === 'BET') {
      if (balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance', balance });
      // Deduct from winnings first, then deposit
      // Casino bet: deposit first, winnings covers shortfall — wallet service enforces this
      // These two strings used to be escaped (`\${gameId}`), so every casino
      // ledger row recorded the literal text "${gameId}" instead of the value —
      // and `gameId` was not in scope, so simply removing the escape would have
      // thrown. It is derived from the payload above; both now interpolate.
      await debitForGameProviderBet(userId, amount, `Casino BET: ${gameId} round ${roundId}`, txId);
    } else if (type === 'WIN') {
      await creditWinnings(userId, amount, `Casino WIN: ${gameId} round ${roundId}`, 'GameTransaction', null, 'win_' + txId);
    } else if (type === 'ROLLBACK' || type === 'REFUND') {
      // ── M-7: a reversal must prove the debit it reverses ─────────────────
      // This used to be a bare `refundOrder(...)`: no check that the round was
      // ever bet on, and no bound on the amount. A provider that is buggy,
      // replayed, or hostile could therefore CREDIT REAL MONEY by rolling back
      // a round that never had a bet, or by rolling back more than was staked.
      //
      // The duplicate-txId check above does not help. It stops the SAME
      // callback applying twice; it says nothing about a DIFFERENT callback
      // that should never have been honoured at all, which is the exposure.
      //
      // Both sums are computed over this round's recorded transactions, so
      // partial rollbacks accumulate correctly — a per-callback check against
      // the bet alone would let any number of them through.
      const priorTx = await GameTransaction.find({ roundId, userId })
        .select('type amount').lean();
      const debited = priorTx
        .filter((t) => t.type === 'BET')
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const refunded = priorTx
        .filter((t) => t.type === 'ROLLBACK' || t.type === 'REFUND')
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

      if (debited <= 0) {
        console.error(`[casino] refusing ${type} for round ${roundId} with no prior debit`);
        return res.status(400).json({ success: false, message: 'No prior debit for this round' });
      }
      if (refunded + amount > debited) {
        console.error(
          `[casino] refusing ${type} for round ${roundId}: would refund ${refunded + amount} of ${debited} debited`,
        );
        return res.status(400).json({ success: false, message: 'Refund exceeds the amount debited for this round' });
      }

      await refundOrder(userId, amount, roundId, 'depositBalance');
    }

    const updatedUser  = await User.findById(userId).lean();
    const newBalance   = (updatedUser.depositBalance || 0) + (updatedUser.winningsBalance || 0);

    await GameTransaction.create({
      roundId, txId, sessionId: body.sessionId || '', userId,
      providerKey, type, amount,
      balanceBefore: balance, balanceAfter: newBalance,
      gameId, gameName: body.gameName || '',
    });

    res.json({ success: true, balance: newBalance, currency: 'INR' });
  } catch (err) {
    console.error('Wallet webhook error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: CRUD for provider config ─────────────────────────────────────────

// GET /api/admin/game-providers
router.get('/admin/game-providers', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const GameProvider = mongoose.model('GameProvider');
    await seedProviders();
    const providers = await GameProvider.find().sort({ category: 1, name: 1 }).lean();
    // Mask secrets for sub-admins
    if (!req.user.isAdmin) {
      for (const p of providers) {
        if (p.apiSecret) p.apiSecret = p.apiSecret.slice(0, 4) + '••••••';
        if (p.webhookSecret) p.webhookSecret = '••••••';
      }
    }
    res.json({ success: true, providers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/game-providers/:key
router.put('/admin/game-providers/:key', authenticate, isAdmin, async (req, res) => {
  try {
    const GameProvider = mongoose.model('GameProvider');
    const { key } = req.params;
    const allowed = ['enabled', 'apiUrl', 'apiKey', 'apiSecret', 'merchantId', 'webhookSecret', 'extraConfig', 'logoUrl', 'description'];
    const update = { updatedBy: req.user.userId, updatedAt: new Date() };
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    const provider = await GameProvider.findOneAndUpdate({ key }, update, { new: true });
    if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });
    res.json({ success: true, provider });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/game-providers/:key/test
router.post('/admin/game-providers/:key/test', authenticate, isAdmin, async (req, res) => {
  try {
    const GameProvider = mongoose.model('GameProvider');
    const provider = await GameProvider.findOne({ key: req.params.key });
    if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });
    if (!provider.apiKey || !provider.apiUrl) return res.status(400).json({ success: false, message: 'API URL and API Key are required to test' });

    // Simple connectivity test
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      await networkClient.request(provider.apiUrl, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(timeout);
      res.json({ success: true, message: `✓ ${provider.name} endpoint is reachable` });
    } catch (e) {
      res.json({ success: false, message: `✗ Could not reach ${provider.apiUrl}: ${e.message}` });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/game-providers/transactions — game wallet transaction history
router.get('/admin/game-transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const GameTransaction = mongoose.model('GameTransaction');
    const { providerKey, userId, page = 1, limit = 30 } = req.query;
    const filter = {};
    if (providerKey) filter.providerKey = providerKey;
    if (userId) filter.userId = userId;
    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      GameTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).populate('userId', 'username mobile').lean(),
      GameTransaction.countDocuments(filter),
    ]);
    res.json({ success: true, transactions: items, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// POST /api/game/admin/game-providers — create a brand-new provider (any name, key, category)
router.post('/admin/game-providers', authenticate, isAdmin, async (req, res) => {
  try {
    const GameProvider = mongoose.model('GameProvider');
    const { key, name, category, description, logoUrl, apiUrl, apiKey, apiSecret, merchantId, webhookSecret, extraConfig } = req.body;
    if (!key || !name || !category) {
      return res.status(400).json({ success: false, message: 'key, name, and category are required' });
    }
    const slug = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const existing = await GameProvider.findOne({ key: slug });
    if (existing) return res.status(409).json({ success: false, message: `Provider "${slug}" already exists` });
    const provider = await GameProvider.create({
      key: slug, name: name.trim(), category,
      description: description || '', logoUrl: logoUrl || '',
      apiUrl: apiUrl || '', apiKey: apiKey || '', apiSecret: apiSecret || '',
      merchantId: merchantId || '', webhookSecret: webhookSecret || '',
      extraConfig: extraConfig || {}, enabled: false, updatedBy: req.user.userId,
    });
    res.json({ success: true, provider });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/game/admin/game-providers/:key
router.delete('/admin/game-providers/:key', authenticate, isAdmin, async (req, res) => {
  try {
    const GameProvider = mongoose.model('GameProvider');
    const provider = await GameProvider.findOneAndDelete({ key: req.params.key });
    if (!provider) return res.status(404).json({ success: false, message: 'Provider not found' });
    res.json({ success: true, message: `${provider.name} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
