// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * usdtDeposit.service.js — USDT buys paid to the platform on BNB Smart Chain
 * (owner, 2026-10-18: BSC only, one address per order, no merchant).
 *
 *   openPlatformUsdtBuy   the order and its own address, started at once
 *   watchUsdtDeposits     the cron tick: read the chain, record transfers,
 *                         credit every order they cover
 *   creditIfCovered       one order, now (the tick, and expiry's last look)
 *
 * The chain is read only through `usdtBsc.js`; the rows are written only by
 * `usdtDeposits.js`; the money moves only through `walletAuthority`.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import {
  configuredAccountKey, keyIdOf, deriveDepositAddress, latestBlock, usdtTransfersTo, usdtDepositsConfigured, MICRO_PER_USDT,
} from './usdtBsc.js';
import { completeUsdtBuy } from '../wallet/walletAuthority.service.js';
import { emitOrderUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import { notify } from '../communication/communication.service.js';
import { sendAlert } from '../../services/alerting.service.js';

/** How many blocks one `eth_getLogs` asks for. Public BSC nodes refuse wide ranges. */
export const LOG_BLOCK_RANGE = Math.max(1, Number(process.env.BSC_LOG_BLOCK_RANGE) || 500);
/** At most this many blocks per tick, so a watcher that was down catches up in steps. */
export const MAX_BLOCKS_PER_TICK = 20 * LOG_BLOCK_RANGE;
/** Where a watcher with no cursor yet starts: this many blocks behind the safe head. */
export const FIRST_RUN_LOOKBACK_BLOCKS = 2000;
/** Recipient topics per `eth_getLogs` (an OR list). */
const ADDRESSES_PER_CALL = 100;
/**
 * Every tick reads this many blocks behind the cursor again. A load-balanced
 * node can answer `[]` for blocks one of its backends has not seen yet rather
 * than an error; reading the recent blocks twice catches what it missed.
 * Recording is once per (hash, log index), so a second sighting is a no-op.
 */
export const RESCAN_BLOCKS = 200;
/**
 * A USDT buy past its deadline lapses only once the watcher has read the chain
 * this long after the deadline (plus a few seconds per confirmation), so money
 * sent just in time is credited, not counted as an unpaid buy.
 */
export const EXPIRY_GRACE_SECONDS = 120;

/** The admin's USDT deposit settings (`SystemConfig.usdtDeposits`). */
export function usdtDepositSettings(cfg) {
  const g = cfg?.usdtDeposits ?? {};
  return {
    paymentWindowMinutes: Number(g.paymentWindowMinutes ?? 60), // schema default: 60
    confirmations: Number(g.confirmations ?? 15),               // schema default: 15
    lateWatchHours: Number(g.lateWatchHours ?? 72),             // schema default: 72
  };
}

/**
 * Write a USDT buy: the order, already started, and the address derived for it
 * alone. Refused 503 (`USDT_DEPOSITS_UNAVAILABLE`) before anything is written
 * when this deployment has no xpub or no BSC node configured.
 */
export async function openPlatformUsdtBuy(orderInput, cfg) {
  const key = configuredAccountKey();
  if (!String(process.env.BSC_RPC_URL ?? '').trim()) {
    throw Object.assign(new Error('USDT deposits are not available right now. Please try again later.'),
      { status: 503, code: 'USDT_DEPOSITS_UNAVAILABLE' });
  }
  const { paymentWindowMinutes } = usdtDepositSettings(cfg ?? await getSystemConfig());
  return db.usdtDeposits.openUsdtBuy({
    orderInput, keyId: keyIdOf(key),
    deriveAddress: (index) => deriveDepositAddress(key, index),
    windowSeconds: paymentWindowMinutes * 60,
  });
}

const usdtText = (micro) => (Number(micro) / MICRO_PER_USDT).toLocaleString('en-IN', { maximumFractionDigits: 6 });

/**
 * Credit one order if what arrived at its address covers it. Safe to call any
 * number of times, from any instance: the transition is the guard.
 * @returns {Promise<{credited: boolean, reason?: string}>}
 */
export async function creditIfCovered(orderId) {
  const done = await completeUsdtBuy(orderId);
  if (!done.ok) {
    if (done.reason === 'reference_taken') {
      sendAlert(`usdt-reference-taken:${orderId}`, 'A USDT transfer hash is already claimed by another order',
        { orderId: String(orderId), ...done.detail }).catch(() => {});
    }
    return { credited: false, reason: done.reason };
  }
  if (done.idempotent) return { credited: false, reason: 'already_completed' };

  const { credit, order } = done;
  await db.utr.releaseUtr(orderId).catch(() => {});
  const { clearPlayerPaymentFailures } = await import('./playerPaymentFailure.service.js');
  await clearPlayerPaymentFailures(credit.userId).catch((e) => console.warn('[usdt] clear failures:', e?.message));

  notify({
    userId: credit.userId, type: 'SUCCESS', title: 'USDT received',
    message: `We received your USDT. ${order.tokenAmount.toLocaleString('en-IN')} tokens are in your wallet.`,
    relatedId: String(orderId), relatedType: 'PaymentOrder',
  }).catch(() => {});
  emitOrderUpdate(credit.userId, 'order_completed', {
    orderId: String(orderId), _id: String(orderId), status: 'COMPLETED', server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: String(orderId), status: 'COMPLETED', server_ts: Date.now() });
  if (credit.excessMicro > 0n) {
    sendAlert(`usdt-overpaid:${orderId}`, 'A USDT buy was overpaid; the excess needs an admin',
      { orderId: String(orderId), excessUsdt: usdtText(credit.excessMicro) }).catch(() => {});
  }
  return { credited: true };
}

/**
 * Money arrived for an order that can no longer take it. Recorded already;
 * this tells the admin and the player.
 */
async function reportLateTransfer(orderId, transfer, state) {
  sendAlert(`usdt-late:${orderId}`, 'USDT arrived for a buy that is no longer open',
    { orderId: String(orderId), state, usdt: usdtText(transfer.amountMicro), txHash: transfer.txHash }).catch(() => {});
  const order = await db.orders.getOrderRecord(orderId).catch(() => null);
  if (!order || state === 'COMPLETED') return;
  notify({
    userId: String(order.userId), type: 'WARNING', title: 'USDT received after your order closed',
    message: `${usdtText(transfer.amountMicro)} USDT arrived after this order had closed, so it was not credited automatically. `
      + 'Our team has been told and will sort it out with you.',
    relatedId: String(orderId), relatedType: 'PaymentOrder',
  }).catch(() => {});
}

/**
 * One tick of the watcher. Reads the chain from the cursor to the newest block
 * with enough confirmations, records every USDT transfer to a watched address,
 * then credits every open order that has received anything.
 *
 * Order of reads matters: the chain head FIRST, then the watched addresses. An
 * order created after the address list was read can only be paid in a block
 * after the head was read, which this tick does not reach; the next one does.
 */
export async function watchUsdtDeposits() {
  if (!usdtDepositsConfigured()) return { skipped: 'not_configured' };

  const { confirmations, lateWatchHours } = usdtDepositSettings(await getSystemConfig());
  const touched = new Set();
  let recorded = 0;
  let scannedTo = null;
  let head = null;
  try {
    head = await latestBlock();
    const safe = head - confirmations;
    const watched = await db.usdtDeposits.watchedAddresses({ lateWatchHours });
    const cursor = await db.usdtDeposits.readCursor();
    const start = cursor ? cursor.nextBlock : Math.max(0, safe - FIRST_RUN_LOOKBACK_BLOCKS);
    let from = cursor ? Math.max(0, start - RESCAN_BLOCKS) : start;
    const stop = Math.min(safe, start + MAX_BLOCKS_PER_TICK - 1);
    const addresses = watched.map((w) => w.address);

    while (from <= stop) {
      const to = Math.min(from + LOG_BLOCK_RANGE - 1, stop);
      for (let i = 0; i < addresses.length; i += ADDRESSES_PER_CALL) {
        const transfers = await usdtTransfersTo(addresses.slice(i, i + ADDRESSES_PER_CALL), from, to);
        for (const t of transfers) {
          if (t.amountMicro <= 0n) continue;
          const r = await db.usdtDeposits.recordTransfer(t);
          if (!r.recorded) continue;
          recorded += 1;
          if (r.orderState === 'PROCESSING') touched.add(r.orderId);
          else await reportLateTransfer(r.orderId, t, r.orderState);
        }
      }
      await db.usdtDeposits.advanceCursor({ nextBlock: to + 1, headBlock: head });
      scannedTo = to;
      from = to + 1;
    }
    if (scannedTo === null) await db.usdtDeposits.advanceCursor({ nextBlock: from, headBlock: head });
  } catch (e) {
    await db.usdtDeposits.recordCursorError({ message: e.message }).catch(() => {});
    sendAlert('usdt-watcher-failed', 'The USDT deposit watcher cannot read BNB Smart Chain', { error: e.message })
      .catch(() => {});
    console.error('[usdt-watcher]', e.message);
  }

  // Every open order with money at its address, not only this tick's: a credit
  // that failed last time (a crash, a refusal since fixed) is retried here.
  for (const orderId of await db.usdtDeposits.processingOrdersWithTransfers()) touched.add(orderId);
  let credited = 0;
  for (const orderId of touched) {
    try {
      if ((await creditIfCovered(orderId)).credited) credited += 1;
    } catch (e) {
      console.error(`[usdt-watcher] credit ${orderId}:`, e.message);
      sendAlert(`usdt-credit-failed:${orderId}`, 'A USDT buy could not be credited', { orderId, error: e.message })
        .catch(() => {});
    }
  }
  return { head, scannedTo, recorded, credited };
}

/**
 * Whether a USDT buy past its deadline may lapse now (`expireOrders`): only
 * once the watcher has read, caught up, past the deadline and its grace, so a
 * payment confirmed late or a watcher running behind never turns into an
 * unpaid buy against the player. A deployment that cannot watch, or an order
 * past the late-money watch, lapses anyway: nothing more would be read for it.
 */
export async function usdtBuyMayLapse(expiresAt, cfg) {
  if (!usdtDepositsConfigured()) return true;
  const { confirmations, lateWatchHours } = usdtDepositSettings(cfg ?? await getSystemConfig());
  const deadline = new Date(expiresAt).getTime();
  if (!Number.isFinite(deadline)) return true;
  if (Date.now() > deadline + lateWatchHours * 3600_000) return true;
  const cursor = await db.usdtDeposits.readCursor();
  if (!cursor?.lastOkAt || cursor.headBlock === null) return false;
  const caughtUp = cursor.headBlock - cursor.nextBlock <= confirmations + 1;
  const readAfter = new Date(cursor.lastOkAt).getTime() >= deadline + (EXPIRY_GRACE_SECONDS + 3 * confirmations) * 1000;
  return caughtUp && readAfter;
}

/** The watcher's health for the admin page: the cursor and how far behind it is. */
export async function watcherStatus() {
  const cursor = await db.usdtDeposits.readCursor();
  const configured = usdtDepositsConfigured();
  return {
    configured,
    // The key new addresses are derived from now (`keyIdOf`), so an admin can
    // see a rotation took: every address keeps the key it was made under.
    activeKeyId: configured ? keyIdOf(configuredAccountKey()) : null,
    nextBlock: cursor?.nextBlock ?? null,
    headBlock: cursor?.headBlock ?? null,
    lastOkAt: cursor?.lastOkAt ?? null,
    lastError: cursor?.lastError ?? null,
    lastErrorAt: cursor?.lastErrorAt ?? null,
  };
}
