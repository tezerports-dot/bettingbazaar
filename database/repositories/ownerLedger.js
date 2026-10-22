// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The owner's dashboard (owner, 2026-10-22): the platform's figures over any
 * window, three separate ledgers, and the weekly profit the owner may take
 * out. Where the supply is comes from `tokenHolders`, which owns that.
 *
 * Read only over every table it reads (§2: each figure from its owner); the
 * one writer of `owner_settlements` and `owner_settlement_schedule`.
 *
 * ── The three ledgers, as the owner set them ────────────────────────────────
 *   VIP revenue   what real money earned: each VIP round's side difference
 *                 (the real pool less what winners were paid before the fee),
 *                 the winnings fee, casino and cricket kept, and the order
 *                 commission the platform keeps on USDT orders it serves
 *                 itself (no merchant to pay; at today's rates). Its costs:
 *                 commission paid to merchants, and General bonuses CLAIMED
 *                 (unlocked into withdrawable winnings). Players pay no deposit
 *                 fee (owner's card, 2026-10-22: "commission is a cost").
 *   Merchants     who served what, and what each was paid in commission: the
 *                 cost side of the payment gateway, by merchant.
 *   General       bonuses granted out of the supply, what General play won
 *                 back, and what was claimed; only the claimed part is a cost,
 *                 and it is the VIP ledger that pays it.
 * The RTP fund's share is shown inside VIP revenue, and its balance is held
 * back from what the owner may claim, because house bets pay it out again.
 *
 * ── Windows ──────────────────────────────────────────────────────────────────
 * Every windowed figure takes `from`/`to` TIMESTAMPS (either null: open). The
 * routes turn IST days into them; the weekly settlement uses the owner's week.
 */
import { pgQuery, withTransaction } from '../client.js';
import { paiseToRupees } from '../../backend/shared/money.js';
import { randomBytes } from 'node:crypto';
import { getSystemConfig } from './config.js';
import { commissionRates } from './teamCommission.js';

const num = (v) => Number(v ?? 0);
const rs = (paise) => paiseToRupees(num(paise));
const refuse = (status, code, message) => Object.assign(new Error(message), { status, code });
/** Today's order commission rates: what the platform keeps on a USDT order it serves itself. */
const ratesNow = async () => commissionRates(await getSystemConfig());

/** A timestamp window on `col`, `$1`/`$2` timestamptz or null. */
const between = (col) => `($1::timestamptz IS NULL OR ${col} >= $1) AND ($2::timestamptz IS NULL OR ${col} < $2)`;

// ── The VIP revenue ledger ──────────────────────────────────────────────────

/**
 * The VIP ledger's lines as SQL scalars over the window `$1`..`$2`, with the
 * deposit and withdrawal commission rates (basis points) as `$3`/`$4`. One
 * text, used for any window and for each of the owner's weeks.
 */
const VIP_LINES = (w) => ({
  side: `(SELECT COALESCE(SUM(net_profit_paise - total_platform_fees_paise), 0) FROM cycles
           WHERE audience = 'VIP' AND is_settled AND ${w('settled_at')})`,
  fees: `(SELECT COALESCE(SUM(total_platform_fees_paise), 0) FROM cycles
           WHERE audience = 'VIP' AND is_settled AND ${w('settled_at')})`,
  rounds: `(SELECT COUNT(*) FROM cycles WHERE audience = 'VIP' AND is_settled AND ${w('settled_at')})`,
  casino: `(SELECT COALESCE(SUM(CASE WHEN tx_type = 'BET' THEN amount_paise
                                    WHEN tx_type IN ('WIN', 'REFUND', 'ROLLBACK') THEN -amount_paise ELSE 0 END), 0)
              FROM game_transactions WHERE ${w('created_at')})`,
  cricket: `(SELECT COALESCE(SUM(stakes_paise - claims_paid_paise - won_paid_paise), 0) FROM cricket_polls
              WHERE status IN ('SETTLED', 'VOID') AND ${w('settled_at')})`,
  usdtKept: `(SELECT COALESCE(SUM(CASE order_type WHEN 'DEPOSIT' THEN (token_amount_paise * $3::bigint) / 10000
                                                   ELSE (token_amount_paise * $4::bigint) / 10000 END), 0)
               FROM order_states WHERE state = 'COMPLETED' AND currency = 'USDT' AND team_id IS NULL
                AND ${w('completed_at')})`,
  commission: `(SELECT COALESCE(SUM(commission_paise), 0) FROM team_commissions WHERE ${w('created_at')})`,
  claimed: `(SELECT COALESCE(SUM(amount_paise), 0) FROM wallet_ledger
              WHERE field = 'winningsBalance' AND tx_type = 'CREDIT'
                AND tx_id LIKE 'promo\\_unlock\\_%\\_in' AND ${w('created_at')})`,
  rtp: `(SELECT COALESCE(SUM(delta_paise), 0) FROM rtp_fund_entries WHERE audience = 'VIP' AND ${w('created_at')})`,
});

const VIP_NET = (l) => `(${l.side} + ${l.fees} + ${l.casino} + ${l.cricket} + ${l.usdtKept} - ${l.commission} - ${l.claimed})`;

const W = (col) => between(col);

/** The VIP ledger over one window. */
export async function vipLedger({ from = null, to = null } = {}) {
  const rates = await ratesNow();
  const l = VIP_LINES(W);
  const { rows } = await pgQuery(
    `SELECT ${l.side} AS side, ${l.fees} AS fees, ${l.rounds} AS rounds, ${l.casino} AS casino,
            ${l.cricket} AS cricket, ${l.usdtKept} AS usdt_kept, ${l.commission} AS commission,
            ${l.claimed} AS claimed, ${l.rtp} AS rtp,
            (SELECT COALESCE(SUM(amount_paise), 0) FROM owner_settlements WHERE ${W('created_at')}) AS withdrawn,
            (SELECT COALESCE(SUM(GREATEST(balance_paise, 0)), 0) FROM rtp_funds WHERE audience = 'VIP') AS rtp_balance`,
    [from, to, rates.bp.DEPOSIT, rates.bp.WITHDRAWAL], 'owner_vip_ledger',
  );
  const r = rows[0];
  const revenue = num(r.side) + num(r.fees) + num(r.casino) + num(r.cricket) + num(r.usdt_kept);
  const costs = num(r.commission) + num(r.claimed);
  return {
    revenue: {
      cycleSides: rs(r.side), winningFees: rs(r.fees), rounds: num(r.rounds),
      casino: rs(r.casino), cricket: rs(r.cricket), usdtCommissionKept: rs(r.usdt_kept),
      total: rs(revenue),
    },
    rtp: { setAside: rs(r.rtp), balanceNow: rs(r.rtp_balance) },
    costs: { merchantCommission: rs(r.commission), claimedGeneralBonuses: rs(r.claimed), total: rs(costs) },
    netProfit: rs(revenue - costs),
    ownerWithdrawn: rs(r.withdrawn),
    rates: { depositPercent: rates.depositPercent, withdrawalPercent: rates.withdrawalPercent },
  };
}

// ── The merchant ledger ─────────────────────────────────────────────────────

/**
 * Every team and merchant account: tokens it holds now, and in the window the
 * buys and sells it served and the commission it was paid, largest volume
 * first. Its totals are the merchant cost line of the VIP ledger.
 */
export async function merchantLedger({ from = null, to = null, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `WITH served AS (
       SELECT team_id,
              COUNT(*) FILTER (WHERE order_type = 'DEPOSIT') AS buys,
              COALESCE(SUM(token_amount_paise) FILTER (WHERE order_type = 'DEPOSIT'), 0) AS buy_paise,
              COUNT(*) FILTER (WHERE order_type = 'WITHDRAWAL') AS sells,
              COALESCE(SUM(token_amount_paise) FILTER (WHERE order_type = 'WITHDRAWAL'), 0) AS sell_paise
         FROM order_states
        WHERE state = 'COMPLETED' AND team_id IS NOT NULL AND ${between('completed_at')}
        GROUP BY team_id
     ), paid AS (
       SELECT team_id, COALESCE(SUM(commission_paise), 0) AS commission
         FROM team_commissions WHERE ${between('created_at')} GROUP BY team_id
     )
     SELECT t.team_id, t.name, CASE WHEN t.supervisor_id IS NULL THEN 'DIRECT' ELSE 'AGENT' END AS kind,
            COALESCE(sup.name, own.name) AS owner,
            COALESCE(tp.available_paise, 0) AS available, COALESCE(tp.held_paise, 0) AS held,
            COALESCE(s.buys, 0) AS buys, COALESCE(s.buy_paise, 0) AS buy_paise,
            COALESCE(s.sells, 0) AS sells, COALESCE(s.sell_paise, 0) AS sell_paise,
            COALESCE(p.commission, 0) AS commission
       FROM teams t
       LEFT JOIN team_pools tp ON tp.team_id = t.team_id
       LEFT JOIN merchants sup ON sup.merchant_id = t.supervisor_id
       LEFT JOIN merchants own ON own.merchant_id = t.owner_merchant_id
       LEFT JOIN served s ON s.team_id = t.team_id
       LEFT JOIN paid p ON p.team_id = t.team_id
      WHERE s.team_id IS NOT NULL OR p.team_id IS NOT NULL OR COALESCE(tp.available_paise, 0) + COALESCE(tp.held_paise, 0) > 0
      ORDER BY COALESCE(s.buy_paise, 0) + COALESCE(s.sell_paise, 0) DESC, COALESCE(tp.available_paise, 0) DESC, t.team_id
      LIMIT $3`,
    [from, to, Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'owner_merchant_ledger',
  );
  const merchants = rows.map((r) => ({
    teamId: r.team_id, name: r.name, kind: r.kind, owner: r.owner,
    tokensNow: rs(num(r.available) + num(r.held)), heldNow: rs(r.held),
    buys: num(r.buys), buyTokens: rs(r.buy_paise), sells: num(r.sells), sellTokens: rs(r.sell_paise),
    volume: rs(num(r.buy_paise) + num(r.sell_paise)), commission: rs(r.commission),
  }));
  const sum = (k) => merchants.reduce((s, m) => s + Math.round(m[k] * 100), 0);
  return {
    merchants,
    totals: {
      buys: merchants.reduce((s, m) => s + m.buys, 0), buyTokens: rs(sum('buyTokens')),
      sells: merchants.reduce((s, m) => s + m.sells, 0), sellTokens: rs(sum('sellTokens')),
      volume: rs(sum('volume')), commission: rs(sum('commission')), tokensNow: rs(sum('tokensNow')),
    },
    top: merchants[0] ?? null,
  };
}

// ── The General ledger ──────────────────────────────────────────────────────

/** Bonuses granted, General play, claims, and what is still out, over the window. */
export async function generalLedger({ from = null, to = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT
       (SELECT COALESCE(SUM(amount_paise), 0) FROM promo_grants WHERE source = 'REFERRAL' AND ${between('created_at')}) AS referral,
       (SELECT COUNT(*) FROM promo_grants WHERE source = 'REFERRAL' AND ${between('created_at')}) AS referral_count,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM promo_grants WHERE source = 'FIRST_DEPOSIT' AND ${between('created_at')}) AS first_deposit,
       (SELECT COUNT(*) FROM promo_grants WHERE source = 'FIRST_DEPOSIT' AND ${between('created_at')}) AS first_deposit_count,
       (SELECT COALESCE(SUM(net_profit_paise), 0) FROM cycles WHERE audience = 'GENERAL' AND is_settled AND ${between('settled_at')}) AS play_net,
       (SELECT COUNT(*) FROM cycles WHERE audience = 'GENERAL' AND is_settled AND ${between('settled_at')}) AS rounds,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM wallet_ledger
         WHERE field = 'winningsBalance' AND tx_type = 'CREDIT' AND tx_id LIKE 'promo\\_unlock\\_%\\_in'
           AND ${between('created_at')}) AS claimed,
       (SELECT COALESCE(SUM(w.promo_paise), 0) FROM wallets w) AS outstanding,
       (SELECT COUNT(*) FROM promo_grants WHERE completed_at IS NULL) AS open_grants,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM promo_grants WHERE completed_at IS NULL) AS open_grants_paise`,
    [from, to], 'owner_general_ledger',
  );
  const r = rows[0];
  return {
    granted: {
      referral: { amount: rs(r.referral), count: num(r.referral_count) },
      firstDeposit: { amount: rs(r.first_deposit), count: num(r.first_deposit_count) },
      total: rs(num(r.referral) + num(r.first_deposit)),
    },
    playWonBack: { amount: rs(r.play_net), rounds: num(r.rounds) },
    claimed: rs(r.claimed),
    outstandingNow: rs(r.outstanding),
    openGrantsNow: { count: num(r.open_grants), amount: rs(r.open_grants_paise) },
  };
}

// ── Platform figures ────────────────────────────────────────────────────────

/** The dashboard's counts over the window, beside the money figures. */
export async function platformStats({ from = null, to = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT
       (SELECT COUNT(*) FROM order_states WHERE order_type = 'DEPOSIT' AND state = 'COMPLETED' AND ${between('completed_at')}) AS buys,
       (SELECT COALESCE(SUM(token_amount_paise), 0) FROM order_states WHERE order_type = 'DEPOSIT' AND state = 'COMPLETED' AND ${between('completed_at')}) AS buy_paise,
       (SELECT COUNT(*) FROM order_states WHERE order_type = 'WITHDRAWAL' AND state = 'COMPLETED' AND ${between('completed_at')}) AS sells,
       (SELECT COALESCE(SUM(token_amount_paise), 0) FROM order_states WHERE order_type = 'WITHDRAWAL' AND state = 'COMPLETED' AND ${between('completed_at')}) AS sell_paise,
       (SELECT COALESCE(SUM(commission_paise), 0) FROM team_commissions WHERE ${between('created_at')}) AS commission,
       (SELECT COUNT(*) FROM users WHERE account_type = 'PLAYER' AND ${between('joined_at')}) AS new_players,
       (SELECT COUNT(*) FROM users WHERE account_type = 'PLAYER' AND ($2::timestamptz IS NULL OR joined_at < $2)) AS registered,
       (SELECT COUNT(*) FROM users WHERE account_type = 'PLAYER' AND play_profile = 'VIP') AS vip_players,
       (SELECT COUNT(*) FROM users WHERE account_type = 'PLAYER' AND play_profile = 'GENERAL') AS general_players,
       (SELECT COUNT(DISTINCT b.user_id) FROM bets b JOIN cycles c ON c.cycle_id = b.cycle_id
         WHERE NOT b.is_phantom AND c.audience = 'VIP' AND ${between('b.placed_at')}) AS active_vip,
       (SELECT COUNT(DISTINCT b.user_id) FROM bets b JOIN cycles c ON c.cycle_id = b.cycle_id
         WHERE NOT b.is_phantom AND c.audience = 'GENERAL' AND ${between('b.placed_at')}) AS active_general,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM promo_grants WHERE source = 'REFERRAL' AND ${between('created_at')}) AS referral_bonus,
       (SELECT COUNT(*) FROM (
          SELECT user_id, MIN(completed_at) AS first_at FROM order_states
           WHERE order_type = 'DEPOSIT' AND state = 'COMPLETED' AND completed_at IS NOT NULL GROUP BY user_id) f
         WHERE ${between('f.first_at')}) AS first_depositors,
       (SELECT COUNT(DISTINCT user_id) FROM order_states
         WHERE order_type = 'DEPOSIT' AND state = 'COMPLETED' AND ${between('completed_at')}) AS depositors,
       (SELECT COUNT(DISTINCT user_id) FROM order_states
         WHERE order_type = 'DEPOSIT' AND state = 'COMPLETED' AND completed_at >= now() - interval '7 days') AS weekly_depositors`,
    [from, to], 'owner_platform_stats',
  );
  const r = rows[0];
  return {
    buys: { count: num(r.buys), tokens: rs(r.buy_paise) },
    sells: { count: num(r.sells), tokens: rs(r.sell_paise) },
    merchantCommission: rs(r.commission),
    newPlayers: num(r.new_players),
    registeredPlayers: num(r.registered),
    vipPlayers: num(r.vip_players),
    generalPlayers: num(r.general_players),
    activePlayers: { vip: num(r.active_vip), general: num(r.active_general) },
    referralBonusGiven: rs(r.referral_bonus),
    firstTimeDepositors: num(r.first_depositors),
    depositors: num(r.depositors),
    weeklyDepositors: num(r.weekly_depositors),
  };
}

// ── The owner's weekly settlement ───────────────────────────────────────────

/** Set the moment the owner's weeks are counted from. */
export async function setSchedule(weekStartsAt, actor) {
  const at = new Date(weekStartsAt);
  if (!weekStartsAt || Number.isNaN(at.getTime())) throw refuse(400, 'INVALID_WEEK_START', 'Choose the date and time your week starts.');
  const { rows } = await pgQuery(
    `INSERT INTO owner_settlement_schedule (id, week_starts_at, updated_by) VALUES (TRUE, $1, $2)
     ON CONFLICT (id) DO UPDATE SET week_starts_at = EXCLUDED.week_starts_at, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING week_starts_at, updated_by, updated_at`,
    [at, String(actor ?? '')], 'owner_schedule_set',
  );
  return { weekStartsAt: rows[0].week_starts_at, updatedBy: rows[0].updated_by, updatedAt: rows[0].updated_at };
}

/**
 * The owner's weeks from the schedule's start up to now, each with its VIP net
 * profit and what was withdrawn against it, and what may be claimed now:
 * the net profit of every COMPLETED week, less everything withdrawn, less the
 * RTP fund's VIP balance (held back: house bets pay it out again). Never below
 * zero. `client` reads inside a caller's transaction.
 */
export async function settlementSummary({ client = null, rates = null } = {}) {
  rates ??= await ratesNow();
  const run = (sql, params, name) => (client ? client.query(sql, params) : pgQuery(sql, params, name));
  const sched = (await run('SELECT week_starts_at FROM owner_settlement_schedule WHERE id', [], 'owner_schedule_read')).rows[0];
  if (!sched) return { schedule: null, weeks: [], claimable: 0, withdrawnTotal: 0, rtpHeldBack: 0, currentWeek: null };
  const l = VIP_LINES((col) => `${col} >= w.ws AND ${col} < w.we`);
  const { rows } = await run(
    `WITH w AS (
       SELECT ws, ws + interval '7 days' AS we
         FROM generate_series($1::timestamptz, COALESCE($2::timestamptz, now()), interval '7 days') AS ws
     )
     SELECT w.ws, w.we, w.we <= now() AS complete,
            ${VIP_NET(l)} AS net,
            (SELECT COALESCE(SUM(amount_paise), 0) FROM owner_settlements s WHERE s.week_start = w.ws) AS withdrawn
       FROM w ORDER BY w.ws DESC LIMIT 520`,
    [sched.week_starts_at, null, rates.bp.DEPOSIT, rates.bp.WITHDRAWAL], 'owner_settlement_weeks',
  );
  const totals = (await run(
    `SELECT (SELECT COALESCE(SUM(amount_paise), 0) FROM owner_settlements) AS withdrawn,
            (SELECT COALESCE(SUM(GREATEST(balance_paise, 0)), 0) FROM rtp_funds WHERE audience = 'VIP') AS rtp`,
    [], 'owner_settlement_totals')).rows[0];
  const completeNet = rows.filter((r) => r.complete).reduce((s, r) => s + num(r.net), 0);
  const claimablePaise = Math.max(0, completeNet - num(totals.withdrawn) - num(totals.rtp));
  const weeks = rows.map((r) => ({
    weekStart: r.ws, weekEnd: r.we, complete: r.complete === true,
    netProfit: rs(r.net), withdrawn: rs(r.withdrawn),
  }));
  return {
    schedule: { weekStartsAt: sched.week_starts_at },
    weeks,
    currentWeek: weeks.find((x) => !x.complete) ?? null,
    lastCompleteWeek: weeks.find((x) => x.complete) ?? null,
    completedNetProfit: rs(completeNet),
    withdrawnTotal: rs(totals.withdrawn),
    withdrawnTotalPaise: num(totals.withdrawn),
    rtpHeldBack: rs(totals.rtp),
    claimable: rs(claimablePaise),
    claimablePaise,
  };
}

/**
 * Record `amountPaise` the owner took out, against the last complete week.
 * Refused above what is claimable, decided under one lock so two records at
 * once cannot both pass the same check (§32 S6). A NEGATIVE amount corrects
 * an earlier record (the table is append-only) and must say why.
 */
export async function recordSettlement({ amountPaise, note = null, actor }) {
  const amount = Number(amountPaise);
  if (!Number.isInteger(amount) || amount === 0) throw refuse(400, 'INVALID_AMOUNT', 'Enter how much you took out.');
  const text = note == null ? null : String(note).trim().slice(0, 500) || null;
  if (amount < 0 && !text) throw refuse(400, 'NOTE_REQUIRED', 'Say why you are correcting an earlier record.');
  const rates = await ratesNow();
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('bb_owner_settlement'))`);
    const s = await settlementSummary({ rates, client });
    if (!s.schedule) throw refuse(409, 'NO_WEEK_START', 'Set when your week starts first.');
    if (!s.lastCompleteWeek) throw refuse(409, 'NO_COMPLETE_WEEK', 'Your first week has not finished yet, so there is no profit to settle.');
    if (amount > s.claimablePaise) {
      throw refuse(409, 'OVER_CLAIMABLE', `You can take out at most ₹${s.claimable.toLocaleString('en-IN')} now.`);
    }
    if (amount < 0 && -amount > s.withdrawnTotalPaise) {
      throw refuse(409, 'OVER_WITHDRAWN', 'A correction cannot put back more than was recorded.');
    }
    const id = `own_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    const { rows } = await client.query(
      `INSERT INTO owner_settlements (settlement_id, week_start, week_end, amount_paise, note, created_by)
       VALUES ($1, $2, $2::timestamptz + interval '7 days', $3, $4, $5) RETURNING *`,
      [id, new Date(s.lastCompleteWeek.weekStart), amount, text, String(actor)]);
    return toSettlement(rows[0]);
  });
}

const toSettlement = (r) => ({
  settlementId: r.settlement_id, weekStart: r.week_start, weekEnd: r.week_end,
  amount: rs(r.amount_paise), note: r.note, createdBy: r.created_by, createdAt: r.created_at,
});

/** Every settlement, newest first. */
export async function listSettlements({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    'SELECT * FROM owner_settlements ORDER BY created_at DESC LIMIT $1',
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'owner_settlements_list');
  return rows.map(toSettlement);
}

