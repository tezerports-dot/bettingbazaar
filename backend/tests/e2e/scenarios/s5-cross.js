// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 5: what an ADMIN action does to the OTHER two panels ────────────
// Every case here is a cross-panel effect: the admin acts, and the merchant or
// the player has to see it. A backend that records the decision while the other
// panel carries on as before is the §28 shape.
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../seed.js';
import { playerToken, merchantToken, adminToken, GET, POST, PUT, check, note } from '../harness.js';

const A = 'CROSS';
export default async function run() {
  const admin  = await seedAdmin();
  const aT = adminToken(admin);

  // ══ 1. Admin SUSPENDS a merchant ══════════════════════════════════════════
  {
    const m = await seedMerchant({ currency: 'INR', tokensPaise: 500000000 });
    const mT = merchantToken(m);

    const before = await GET(mT, '/api/merchant/profile');
    check(A, 'merchant', 'an ACTIVE merchant can read their own panel', '200 ACTIVE',
      `${before.status} ${before.body.merchant?.status ?? ''}`,
      before.status === 200 && before.body.merchant?.status === 'ACTIVE');

    const susp = await PUT(aT, `/api/admin/merchants/${m.merchantId}/suspend`, { reason: 'e2e cross-panel check' });
    check(A, 'admin', 'suspend the merchant', '200', `${susp.status} ${susp.body.message ?? ''}`, susp.status === 200);

    const row = await pgQuery('SELECT status FROM merchants WHERE merchant_id=$1', [m.merchantId], 'e2e');
    check(A, 'system', 'the suspension is recorded', 'SUSPENDED',
      row.rows[0]?.status ?? 'missing', row.rows[0]?.status === 'SUSPENDED');

    // THE CROSS-PANEL HALF: the merchant's own panel must say so.
    const after = await GET(mT, '/api/merchant/profile');
    check(A, 'merchant', 'the merchant panel reflects the suspension', 'not ACTIVE',
      `${after.status} ${after.body.merchant?.status ?? after.body.message ?? ''}`,
      after.status !== 200 || after.body.merchant?.status !== 'ACTIVE',
      'a suspended merchant must not be shown a working panel');

    // …and they must not be handed new work.
    const cand = await pgQuery(
      `SELECT 1 FROM merchants WHERE merchant_id=$1 AND status='ACTIVE'`, [m.merchantId], 'e2e');
    check(A, 'system', 'a suspended merchant is not an assignment candidate', 'no ACTIVE row',
      cand.rows.length ? 'STILL ACTIVE' : 'not a candidate', cand.rows.length === 0);

    // ══ 2. Reinstating zeroes the streak (§2) ═══════════════════════════════
    await pgQuery('UPDATE merchants SET consecutive_rejections = 3 WHERE merchant_id=$1', [m.merchantId], 'e2e');
    const appr = await PUT(aT, `/api/admin/merchants/${m.merchantId}/approve`, {});
    check(A, 'admin', 'reinstate the merchant', '200', `${appr.status} ${appr.body.message ?? ''}`, appr.status === 200);

    const rej = await pgQuery(
      'SELECT status, consecutive_rejections FROM merchants WHERE merchant_id=$1', [m.merchantId], 'e2e');
    check(A, 'system', 'reinstating zeroes the refusal streak in the same statement', 'ACTIVE, 0',
      `${rej.rows[0]?.status}, ${rej.rows[0]?.consecutive_rejections}`,
      rej.rows[0]?.consecutive_rejections === 0,
      '§2: left at the cap, the very next refusal re-suspends and the admin decision lasts one order');

    const back = await GET(mT, '/api/merchant/profile');
    check(A, 'merchant', 'the merchant panel works again after reinstatement', '200 ACTIVE',
      `${back.status} ${back.body.merchant?.status ?? ''}`,
      back.status === 200 && back.body.merchant?.status === 'ACTIVE');
  }

  // ══ 3. The assignment PAUSE is not a suspension, and has no timer ══════════
  {
    const m = await seedMerchant({ currency: 'INR', tokensPaise: 500000000 });
    const mT = merchantToken(m);
    await pgQuery(
      `UPDATE merchants SET assignment_paused_at = now(), consecutive_expiries = 3,
              assignment_pause_reason = 'e2e: three unanswered buys'
        WHERE merchant_id = $1`, [m.merchantId], 'e2e');

    const paused = await GET(mT, '/api/merchant/profile');
    check(A, 'merchant', 'a paused merchant keeps their panel and standing', '200 ACTIVE',
      `${paused.status} ${paused.body.merchant?.status ?? ''}`,
      paused.status === 200 && paused.body.merchant?.status === 'ACTIVE',
      '§2: a pause is NOT a suspension — they keep orders, balance and standing');

    const resume = await PUT(aT, `/api/admin/merchants/${m.merchantId}/resume-assignment`, { note: 'e2e resume' });
    check(A, 'admin', 'resume assignment', '200', `${resume.status} ${resume.body.message ?? ''}`, resume.status === 200);

    const r = await pgQuery(
      'SELECT assignment_paused_at, consecutive_expiries FROM merchants WHERE merchant_id=$1', [m.merchantId], 'e2e');
    check(A, 'system', 'resuming clears the pause AND the expiry run together', 'null, 0',
      `${r.rows[0]?.assignment_paused_at}, ${r.rows[0]?.consecutive_expiries}`,
      r.rows[0]?.assignment_paused_at === null && r.rows[0]?.consecutive_expiries === 0);
  }

  // ══ 4. Admin BLOCKS a player ══════════════════════════════════════════════
  {
    const p = await seedPlayer({ balancePaise: 500000 });
    const pT = playerToken(p);

    const ok = await GET(pT, '/api/user/bet-limits');
    check(A, 'player', 'an active player can read their wallet', '200', String(ok.status), ok.status === 200);

    const blk = await PUT(aT, `/api/admin/users/${p.userId}/block`, { reason: 'e2e cross-panel check' });
    check(A, 'admin', 'block the player', '200', `${blk.status} ${blk.body.message ?? ''}`, blk.status === 200);

    const shut = await GET(pT, '/api/user/bet-limits');
    check(A, 'player', 'a blocked player is refused', '4xx',
      String(shut.status), shut.status >= 400,
      'cross-panel: the admin decision must reach the player panel');

    // The player has to be able to find out WHY. That is what the notification
    // inbox is for — and until this session mounted the bell in the shell, the
    // rows were written and no screen rendered them (§28).
    const notes = await pgQuery(
      `SELECT kind, title FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [p.userId], 'e2e');
    check(A, 'system', 'blocking writes the player an explanation', 'at least one notification',
      notes.rows.length ? notes.rows.map(r => r.kind).join(', ') : 'NONE WRITTEN',
      notes.rows.length > 0,
      'it is readable now the bell is mounted; before, it was written and unreachable');

    const unb = await PUT(aT, `/api/admin/users/${p.userId}/unblock?resetWarnings=true`, {});
    check(A, 'admin', 'unblock with resetWarnings=true', '200 (§21: the write after the commit)',
      `${unb.status} ${unb.body.message ?? ''}`, unb.status === 200);

    const st = await pgQuery('SELECT is_blocked, status FROM users WHERE user_id=$1', [p.userId], 'e2e');
    check(A, 'system', 'unblock leaves is_blocked and status agreeing', 'false / not BLOCKED',
      `${st.rows[0]?.is_blocked} / ${st.rows[0]?.status}`,
      st.rows[0]?.is_blocked === false && st.rows[0]?.status !== 'BLOCKED',
      '§21: this 500\'d AFTER the unblock committed, leaving is_blocked false and status BLOCKED');

    const backIn = await GET(pT, '/api/user/bet-limits');
    check(A, 'player', 'the player panel works again after unblocking', '200',
      String(backIn.status), backIn.status === 200);

    // And the inbox must not leave them reading a suspension that is over.
    const after = await GET(pT, '/api/user/notifications');
    const titles = (after.body?.notifications ?? []).map(n => n.title);
    check(A, 'player', 'the player can READ both notices through the inbox route', 'suspended + restored',
      `${after.status} [${titles.join(' | ')}]`,
      after.status === 200 && titles.some(t => /suspended/i.test(t)) && titles.some(t => /restored/i.test(t)),
      'the route the bell polls — this is the end-to-end half, not just the row');
  }

  // ══ 5. The settlement rail an admin sets is what all three panels read ═════
  {
    const mode = await GET(aT, '/api/admin/payment-mode');
    check(A, 'admin', 'admin can read the active settlement rail', '200 with a mode',
      `${mode.status} ${JSON.stringify(mode.body).slice(0, 90)}`, mode.status === 200);

    const p = await seedPlayer({});
    const sys = await GET(playerToken(p), '/api/v1/system/config');
    const playerMode = sys.body?.config?.paymentMode ?? null;
    check(A, 'player', 'the player panel is told the same rail', 'a mode, not null',
      String(playerMode), !!playerMode,
      'WalletPage branches on this — a null here means the buy screen guesses');

    const m = await seedMerchant({ currency: 'INR', tokensPaise: 100000 });
    const mm = await GET(merchantToken(m), '/api/merchant/payment-mode');
    const merchMode = mm.body?.activeMode ?? null;
    check(A, 'merchant', 'the merchant panel is told the same rail', `${playerMode}`,
      `${mm.status} ${merchMode}`, mm.status === 200 && merchMode === playerMode,
      'one owner (§2 payment_mode_policies) — three panels must not disagree about which rail is live');
  }
}
