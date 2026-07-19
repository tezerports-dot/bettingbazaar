// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Reporting Platform (BBEPS Phase 012 — Enterprise Services tier).
//
// Read-only reports DERIVED from the authoritative records: the settlement
// ledger (AccountingEvent — financial truth), PaymentOrders (funding), and
// the bonus/wallet ledgers. This platform stores nothing, mutates nothing,
// and never re-computes business math — it aggregates what the owning
// platforms already recorded.

import mongoose from 'mongoose';
import { ACCOUNTS, ACCOUNT_CODES } from '../revenue/chartOfAccounts.js';

function periodMatch(from, to, field = 'occurredAt') {
  const m = {};
  if (from) m.$gte = new Date(from);
  if (to)   m.$lte = new Date(to);
  return Object.keys(m).length ? { [field]: m } : {};
}

/**
 * financialReport — period activity per ledger account (movement, not just
 * closing balance) + per-event-type totals. The regulatory-grade view:
 * everything traces to append-only journal entries.
 */
export async function financialReport({ from, to } = {}) {
  const AccountingEvent = mongoose.model('AccountingEvent');
  const match = periodMatch(from, to);

  const [byAccount, byEventType, entryCount] = await Promise.all([
    AccountingEvent.aggregate([
      { $match: match },
      { $unwind: '$postings' },
      { $group: {
          _id: '$postings.account',
          debitMinor:  { $sum: { $cond: [{ $gt: ['$postings.amountMinor', 0] }, '$postings.amountMinor', 0] } },
          creditMinor: { $sum: { $cond: [{ $lt: ['$postings.amountMinor', 0] }, { $abs: '$postings.amountMinor' }, 0] } },
          netMinor:    { $sum: '$postings.amountMinor' },
      } },
    ]),
    AccountingEvent.aggregate([
      { $match: match },
      { $group: { _id: '$eventType', events: { $sum: 1 } } },
      { $sort: { events: -1 } },
    ]),
    AccountingEvent.countDocuments(match),
  ]);

  const accounts = ACCOUNT_CODES.map(code => {
    const row = byAccount.find(r => r._id === code) || { debitMinor: 0, creditMinor: 0, netMinor: 0 };
    const normal = ACCOUNTS[code].normalBalance;
    return {
      account: code,
      normalBalance: normal,
      debit:  row.debitMinor / 100,
      credit: row.creditMinor / 100,
      netMovement: (normal === 'CREDIT' ? -row.netMinor : row.netMinor) / 100,
    };
  });

  return {
    period: { from: from || null, to: to || null },
    entryCount,
    accounts,
    eventTypes: byEventType.map(r => ({ eventType: r._id, events: r.events })),
  };
}

/** settlementReport — daily settlement ledger activity (chart/export-ready). */
export async function settlementReport({ from, to } = {}) {
  const AccountingEvent = mongoose.model('AccountingEvent');
  return AccountingEvent.aggregate([
    { $match: periodMatch(from, to) },
    { $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } }, eventType: '$eventType' },
        events: { $sum: 1 },
        grossMinor: { $sum: { $reduce: {
          input: '$postings', initialValue: 0,
          in: { $add: ['$$value', { $cond: [{ $gt: ['$$this.amountMinor', 0] }, '$$this.amountMinor', 0] }] },
        } } },
    } },
    { $group: {
        _id: '$_id.day',
        byEventType: { $push: { eventType: '$_id.eventType', events: '$events', gross: { $divide: ['$grossMinor', 100] } } },
        totalEvents: { $sum: '$events' },
    } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, day: '$_id', byEventType: 1, totalEvents: 1 } },
  ]);
}

/** merchantReport — per-merchant funding + bonus activity over a period. */
export async function merchantReport({ from, to } = {}) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const AccountingEvent = mongoose.model('AccountingEvent');
  const Merchant = mongoose.model('Merchant');

  const [orders, bonuses, merchants] = await Promise.all([
    PaymentOrder.aggregate([
      { $match: { merchantId: { $ne: null }, status: 'COMPLETED', ...periodMatch(from, to, 'completedAt') } },
      { $group: {
          _id: { merchantId: '$merchantId', type: '$type' },
          orders: { $sum: 1 },
          volume: { $sum: '$fiatAmount' },
      } },
    ]),
    AccountingEvent.aggregate([
      { $match: { eventType: 'MERCHANT_BONUS_ISSUED', ...periodMatch(from, to) } },
      { $unwind: '$postings' },
      { $match: { 'postings.account': ACCOUNTS.MERCHANT_FUNDS.code } },
      { $group: { _id: '$refId', bonusMinor: { $sum: { $abs: '$postings.amountMinor' } }, issuances: { $sum: 1 } } },
    ]),
    Merchant.find({}, 'username tokenBalance').lean(),
  ]);

  const nameById = Object.fromEntries(merchants.map(m => [String(m._id), m.username]));
  const rows = {};
  for (const o of orders) {
    const id = String(o._id.merchantId);
    rows[id] = rows[id] || { merchantId: id, username: nameById[id] || 'unknown',
      deposits: 0, depositVolume: 0, withdrawals: 0, withdrawalVolume: 0, bonuses: 0, bonusTotal: 0 };
    if (o._id.type === 'DEPOSIT') { rows[id].deposits = o.orders; rows[id].depositVolume = o.volume; }
    else { rows[id].withdrawals = o.orders; rows[id].withdrawalVolume = o.volume; }
  }
  for (const b of bonuses) {
    const id = String(b._id);
    rows[id] = rows[id] || { merchantId: id, username: nameById[id] || 'unknown',
      deposits: 0, depositVolume: 0, withdrawals: 0, withdrawalVolume: 0, bonuses: 0, bonusTotal: 0 };
    rows[id].bonuses = b.issuances;
    rows[id].bonusTotal = b.bonusMinor / 100;
  }
  return Object.values(rows).sort((a, b) => (b.depositVolume + b.withdrawalVolume) - (a.depositVolume + a.withdrawalVolume));
}

/**
 * regulatoryLedgerExport — flat rows of every journal posting in a period
 * (one row per posting), suitable for CSV export / external audit.
 */
export async function regulatoryLedgerExport({ from, to, limit = 10000 } = {}) {
  const AccountingEvent = mongoose.model('AccountingEvent');
  const entries = await AccountingEvent.find(periodMatch(from, to))
    .sort({ occurredAt: 1, _id: 1 }).limit(limit).lean();

  const rows = [];
  for (const e of entries) {
    for (const p of e.postings) {
      rows.push({
        entryId: String(e._id),
        occurredAt: e.occurredAt?.toISOString?.() || '',
        recordedAt: e.createdAt?.toISOString?.() || '',
        eventType: e.eventType,
        idempotencyKey: e.idempotencyKey,
        refModel: e.refModel,
        refId: e.refId,
        account: p.account,
        side: p.amountMinor >= 0 ? 'DEBIT' : 'CREDIT',
        amountINR: (Math.abs(p.amountMinor) / 100).toFixed(2),
        description: e.description,
      });
    }
  }
  return rows;
}

// toCsv lives in the pure ./csv.util.js so the CPU worker (item 5) can import it
// without pulling mongoose into the worker thread. Re-exported here so existing
// callers/tests that import it from this service keep working unchanged.
export { toCsv } from './csv.util.js';
