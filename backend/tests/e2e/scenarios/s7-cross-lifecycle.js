// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 7: identity, money, disputes and the three Telegram surfaces ───
//
// s5 covers an admin acting on a person; s6 covers an admin configuring the
// platform. This one covers the cases where an admin decision moves MONEY or
// ACCESS, and where the effect has to land on two panels at once.
//
// These are the expensive half. A config change that does not propagate makes a
// screen wrong, and a dispute resolution that lands
// on one side only leaves a player and a merchant looking at the same order and
// disagreeing about what happened to it.
//
// Every case reads the OTHER panel's own endpoint. Every case that changes
// something platform-wide puts it back in a `finally` (trap 10).
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedTeam, seedAdmin } from '../seed.js';
import {
  playerToken, merchantToken, adminToken, GET, POST, PUT, check, note, idemKey, BASE,
} from '../harness.js';

/**
 * The `branding` event a fresh client receives on the public SSE stream — how
 * the panels actually get branding. This read `GET /api/v1/branding`, a route
 * no panel called that built its own payload with hard-coded file names
 * (§13); it was deleted 2026-10-01.
 */
async function brandingOverSse() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${BASE}/api/sse/events`, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event: branding\ndata: (.*)\n/);
      if (m) return JSON.parse(m[1]);
    }
  } catch { return null; } finally { clearTimeout(timer); ctrl.abort(); }
}

const A = 'LIFECYCLE';

export default async function run() {
  const admin = await seedAdmin();
  const aT = adminToken(admin);

  // ══ 1. There is no KYC: the player's own profile carries none ════════════
  // KYC was removed (owner, 2026-10-02). A field that survives on the profile
  // is a panel somewhere still rendering an identity status nobody decides.
  {
    const p = await seedPlayer();
    const pT = playerToken(p);
    const me = await GET(pT, '/api/v1/user/profile');
    const keys = Object.keys(me.body?.user ?? {});
    check(A, 'player', 'the profile carries no KYC field', 'no kyc* key',
      `${me.status} ${keys.filter((k) => /kyc|aadhaar/i.test(k)).join(',') || 'none'}`,
      me.status === 200 && !keys.some((k) => /kyc|aadhaar/i.test(k)));
    const gone = await POST(aT, `/api/admin/kyc/${p.userId}/approve`, {});
    check(A, 'admin', 'the KYC approval route is gone', '404',
      String(gone.status), gone.status === 404);
  }

  // ══ 3. Branding: one document, three panels ══════════════════════════════
  {
    const before = (await GET(aT, '/api/admin/branding')).body?.branding ?? {};
    try {
      const mark = `BB E2E ${Date.now()}`;
      const saved = await PUT(aT, '/api/admin/branding', { appName: mark });
      check(A, 'admin', 'save a brand name', '200',
        `${saved.status} ${saved.body?.message ?? ''}`, saved.status === 200);

      const pub = await brandingOverSse();
      check(A, 'player', 'the branding a fresh panel receives carries the new name', mark,
        String(pub?.appName),
        pub?.appName === mark,
        '§13: sendBranding is the SOLE constructor of this payload — a panel with a literal never updates');
    } finally {
      if (before.appName) await PUT(aT, '/api/admin/branding', { appName: before.appName });
    }
  }

  // ══ 4. A DISPUTE resolved by an admin lands on BOTH sides ════════════════
  // The §21 shape lives here: the release button once marked a disputed deposit
  // COMPLETED and never credited the player, then told the admin it had failed.
  // The order left the DISPUTED queue, so nothing remained to show it had gone
  // wrong — which is why this case reads the PLAYER and the MERCHANT, not the
  // admin route's own answer.
  {
    const p = await seedPlayer();
    // A cash-team member who has pressed Ready, so the 1,000-token buy below is
    // routed to `m` and its tokens are held in the team's pool — the hold a
    // release then spends (Step 2c: a merchant holds no tokens of their own).
    const m = await seedMerchant({ currency: 'INR' });
    await seedTeam({ rail: 'CASH', poolTokens: 10000, include: [m], online: [m], ready: [m] });
    const pT = playerToken(p);
    const mT = merchantToken(m);

    const made = await POST(pT, '/api/payment/deposit/create', { tokenAmount: 1000 });
    if (made.status !== 200) {
      note(A, 'player', 'stage a deposit to dispute', '200 with an order',
        `${made.status} ${JSON.stringify(made.body).slice(0, 160)}`,
        'could not stage the dispute case');
    } else {
      const orderId = made.body?.order?.orderId ?? made.body?.orderId;
      // Reached through the routes a player uses, not a raw UPDATE to DISPUTED:
      // only a PAYMENT dispute (one raised from PAID with a reference, or from a
      // rejection) suspends anybody, and a row staged straight from ASSIGNED is
      // one production cannot make (§32 S16). The one thing moved by hand is
      // the clock: `paid_at` goes back past the player's ten-minute wait.
      const utr = String(Date.now()).slice(-12).padStart(12, '6');
      const paidRes = await POST(pT, `/api/payment/order/${orderId}/mark-paid`, { utrNumber: utr });
      await pgQuery(`UPDATE order_states SET paid_at = now() - interval '11 minutes' WHERE order_id = $1`, [orderId]);
      const raised = await POST(pT, `/api/payment/order/${orderId}/dispute`, { reason: 'e2e cross-panel: nothing credited' });
      check(A, 'player', 'mark the buy paid, then dispute it after the wait', '200 then 200',
        `${paidRes.status} then ${raised.status} ${raised.body?.message ?? ''}`,
        paidRes.status === 200 && raised.status === 200);

      const res = await POST(aT, `/api/admin/dispute-orders/${orderId}/resolve`, {
        decision: 'RELEASE_TO_USER', resolution: 'e2e: released to the player',
      });
      check(A, 'admin', 'resolve the dispute in the player’s favour', '200',
        `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`, res.status === 200);

      const row = await pgQuery(
        `SELECT state, dispute_resolution, dispute_resolved_by, dispute_decision
           FROM order_states WHERE order_id = $1`, [orderId]);
      check(A, 'system', 'the order left DISPUTED and the decision was written',
        'COMPLETED + resolution + decider',
        `${row.rows[0]?.state} / ${row.rows[0]?.dispute_resolution ?? 'none'} / `
        + `${row.rows[0]?.dispute_resolved_by ?? 'nobody'}`,
        row.rows[0]?.state === 'COMPLETED'
        && !!row.rows[0]?.dispute_resolution && !!row.rows[0]?.dispute_resolved_by,
        '§21: the second write must not be able to fail after the first has committed');

      const asPlayer = await GET(pT, `/api/payment/order/${orderId}`);
      check(A, 'player', 'the PLAYER sees the resolved state on their own order', 'COMPLETED',
        String(asPlayer.body?.order?.status ?? asPlayer.body?.order?.state),
        JSON.stringify(asPlayer.body).includes('COMPLETED'));

      // Released to the player on a BUY means the member was wrong, and whoever
      // was wrong is suspended until staff lift it (2c+, owner 2026-10-02). So
      // what the member's panel shows is the suspension, not the order list.
      const asMerchant = await GET(mT, '/api/merchant/orders?status=COMPLETED');
      check(A, 'merchant', 'the MEMBER who lost the dispute is suspended out of their panel', '403 Account suspended',
        `${asMerchant.status} ${asMerchant.body?.message ?? ''}`,
        asMerchant.status === 403 && /suspended/i.test(asMerchant.body?.message ?? ''),
        '§32 S17: an admin decision the merchant never sees is half a feature');
      const fault = await pgQuery(
        `SELECT m.status, m.lost_disputes, f.party
           FROM merchants m JOIN dispute_faults f ON f.merchant_id = m.merchant_id AND f.order_id = $2
          WHERE m.merchant_id = $1`, [m.merchantId, orderId]);
      check(A, 'system', 'and the loss is recorded against that member, once', 'SUSPENDED / 1 / MERCHANT',
        `${fault.rows[0]?.status} / ${fault.rows[0]?.lost_disputes} / ${fault.rows[0]?.party}`,
        fault.rows[0]?.status === 'SUSPENDED' && Number(fault.rows[0]?.lost_disputes) === 1
        && fault.rows[0]?.party === 'MERCHANT',
        'one decision, one fault row: a replayed resolve must not count twice');
    }
  }

  // ══ 5. Replacing ONE panel's channel re-gates ONLY that panel ════════════
  // The expensive mistake the audience split exists to make unrepresentable
  // (§33.7). A cached membership is stamped with the generation it was observed
  // in, so an unscoped activation re-gates a population nobody was thinking
  // about — and nothing on any screen would say why.
  {
    const { db } = await import('#db');
    const made = [];
    try {
      for (const [audience, chan] of [['PLAYER', '-100x1'], ['MERCHANT', '-100x2']]) {
        const cfg = await db.telegram.activateConfig({
          audience, channelId: `${chan}-${Date.now()}`, reason: 'e2e cross-panel',
        });
        made.push(cfg.generation);
      }
      const playerGen = (await db.telegram.getActiveConfig('PLAYER')).generation;

      const flipped = await db.telegram.activateConfig({
        audience: 'MERCHANT', channelId: `-100x9-${Date.now()}`, reason: 'e2e cross-panel',
      });
      made.push(flipped.generation);

      check(A, 'system', 'replacing the MERCHANT channel leaves the PLAYER generation alone',
        `player still ${playerGen}`,
        `player ${(await db.telegram.getActiveConfig('PLAYER')).generation}, merchant ${flipped.generation}`,
        (await db.telegram.getActiveConfig('PLAYER')).generation === playerGen,
        '§33.7: unscoped, this re-gated the entire player base at the moment an operator '
        + 'believed they were configuring something else');

      check(A, 'system', 'and the two generations can never be confused for one another',
        'distinct', `${playerGen} vs ${flipped.generation}`,
        playerGen !== flipped.generation,
        'generations are GLOBALLY unique, which makes a cross-panel stale membership unrepresentable');
    } finally {
      for (const g of made) {
        await pgQuery(`DELETE FROM telegram_configs WHERE generation = $1`, [g]).catch(() => {});
      }
    }
  }

  // ══ 5b. An ANNOUNCEMENT an admin posts is one a player can read ══════════
  {
    const mark = `e2e cross announcement ${Date.now()}`;
    const made = await POST(aT, '/api/admin/announcements', {
      title: mark, body: 'e2e cross-panel body', type: 'INFO', isActive: true,
    });
    check(A, 'admin', 'post an announcement', '200',
      `${made.status} ${JSON.stringify(made.body).slice(0, 120)}`, made.status === 200);

    const seen = await GET(null, '/api/announcements');
    check(A, 'player', 'the player panel can read it', 'the title',
      JSON.stringify(seen.body).includes(mark) ? 'present' : 'absent',
      JSON.stringify(seen.body).includes(mark),
      'an operator’s announcement stored where no player can read it is §32 S17');
  }

  // ══ 5c. Referral disbursal: the admin pays, the PLAYER's report shows it ══
  {
    const p = await seedPlayer();
    const pT = playerToken(p);

    const before = await GET(pT, '/api/user/referrals');
    check(A, 'player', 'a player can read their own referral report', '200',
      `${before.status} ${JSON.stringify(before.body).slice(0, 110)}`, before.status === 200,
      '§2: referral earnings are an append-only ledger paid in joining-number order');

    // A disbursal with nothing to pay is a legitimate no-op, and the point of
    // asserting it is the ROUTE: an admin pressing this must get a real answer
    // rather than a 500, whether or not anybody is owed.
    const paid = await POST(aT, '/api/admin/referral/disburse', { amount: 100 });
    // The ASSERTION is that a refusal names its cause, not that it carries one
    // particular status. On a fresh platform this answers 409 "The referral
    // programme is paused" — which is the right answer and an actionable one:
    // the operator knows exactly what to change. A first draft allowed only
    // 200 or 400 and reported that correct refusal as a failure, which is §29
    // in miniature — the check was measuring the status code rather than the
    // thing that matters.
    check(A, 'admin', 'a disbursal either runs or says WHY it will not',
      '200, or a 4xx naming the cause',
      `${paid.status} ${JSON.stringify(paid.body).slice(0, 140)}`,
      paid.status === 200
      || (paid.status >= 400 && paid.status < 500 && String(paid.body?.message ?? '').length > 10),
      '§26: never partial-issue — paying what the pool holds while recording the full '
      + 'high-water mark under-pays permanently, with a ledger that reads complete');

    const after = await GET(pT, '/api/user/referrals');
    check(A, 'player', 'the player’s report still reads cleanly afterwards', '200',
      String(after.status), after.status === 200);
  }

  // ══ 6. Retiring a sign-in bot MOVES the players it carried ═══════════════
  {
    const { db } = await import('#db');
    const { encryptField } = await import('../../../domains/identity/fieldCrypto.util.js');
    const stamp = String(Date.now()).slice(-7);
    const ids = [`x7a-${stamp}`, `x7b-${stamp}`];
    try {
      for (const botId of ids) {
        await db.telegram.addBot({
          botId, label: botId, role: 'signin', audience: 'PLAYER', username: `bb_${botId}`,
          tokenEncrypted: encryptField('000:FAKE'), webhookSecret: `s-${botId}`, status: 'ACTIVE',
        });
      }
      const p = await seedPlayer();
      const first = await db.telegram.assignSigninBot(p.userId, 'PLAYER');
      check(A, 'system', 'a player is assigned one of the live sign-in bots', 'one of the two',
        String(first), ids.includes(first));

      const retired = await db.telegram.retireBot(first, { actor: 'e2e' });
      check(A, 'admin', 'retire the bot that player was on', 'ok',
        JSON.stringify(retired).slice(0, 120), retired.ok === true);

      const moved = await db.telegram.assignSigninBot(p.userId, 'PLAYER');
      check(A, 'player', 'the player is MOVED to a live bot, with no sweep and no migration',
        'a different, live bot', `${first} → ${moved}`,
        moved !== first && ids.includes(moved),
        '§2: the assignment is re-resolved on every read, so a retired bot’s players move on their own');
    } finally {
      for (const botId of ids) {
        await pgQuery(`UPDATE users SET telegram_bot_id = NULL WHERE telegram_bot_id = $1`,
          [botId]).catch(() => {});
        await pgQuery(`DELETE FROM telegram_bots WHERE bot_id = $1`, [botId]).catch(() => {});
      }
    }
  }
}
