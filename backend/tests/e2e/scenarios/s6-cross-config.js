// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ── Scenario 6: the admin CONFIGURES, and the other panels are told ─────────
//
// s5-cross covers the admin acting on a PERSON — suspend, block, reinstate.
// This one covers the admin acting on the PLATFORM: the numbers, the rates, the
// content and the Telegram surfaces. They fail the same way and it is §32 S17 —
// an admin decision no other panel reflects — but they are harder to notice,
// because the admin screen says "saved" and the operator has no reason to open
// the player app and look.
//
// Every case here reads the OTHER panel's own endpoint, never the admin one it
// just wrote through. An admin route echoing back what it stored proves the
// write; it proves nothing about the screen that has to render it.
//
// ── Trap 10 governs this whole file ────────────────────────────────────────
// `config_documents` is ONE row per scope and it holds the platform's live
// rules, so a case here is not leaving a stale fixture behind — it is leaving
// the platform running under different rules for every scenario after it, in
// the same process. Every case that writes config takes a baseline and puts it
// back in a `finally`, outside any assertion: a restore that only runs when the
// case passed is the one that matters least.
import { db } from '#db';
import { pgQuery } from '#db/client.js';
import { seedMerchant, seedTeam, seedAdmin } from '../seed.js';
import {
  merchantToken, adminToken, GET, POST, PUT, check,
} from '../harness.js';

const A = 'CONFIG';

/** The public payload every player panel reads its money rules from. */
const publicConfig = async () => (await GET(null, '/api/v1/system/config')).body?.config ?? {};

export default async function run() {
  const admin = await seedAdmin();
  const aT = adminToken(admin);

  // ══ 1. Bet limits: admin types a number, the player panel is offered it ═══
  {
    const before = (await GET(aT, '/api/admin/system/config')).body;
    try {
      const saved = await PUT(aT, '/api/admin/system/config', {
        betLimits: { thirtyMin: { min: 70, max: 7000 } },
      });
      check(A, 'admin', 'set the 30-minute bet limits', '200',
        `${saved.status} ${saved.body?.message ?? ''}`, saved.status === 200);

      const pub = await publicConfig();
      check(A, 'player', 'the player panel is offered the NEW bet limits', 'min 70, max 7000',
        `min ${pub.minBet}, max ${pub.maxBet}`,
        pub.minBet === 70 && pub.maxBet === 7000,
        'the panel renders what it is told; a client-side copy is a list an attacker can edit');
    } finally {
      await PUT(aT, '/api/admin/system/config', {
        betLimits: before?.config?.betLimits ?? { thirtyMin: { min: 10, max: 100000 } },
      });
    }
  }

  // ══ 2. The order sizes on offer (Step 2d) ════════════════════════════════
  {
    const before = (await GET(aT, '/api/admin/system/config')).body?.config ?? {};
    try {
      // Switch one cash size and one bank size off: the player is told only
      // the rest, per rail, and the USDT bounds the admin chose.
      await PUT(aT, '/api/admin/system/config', {
        orderSizes: [1000, 5000, 10000, 50000, 500000],
        usdtBuy: { minUsdt: 200, maxUsdt: 5000 },
      });
      const pub = await publicConfig();
      const shown = `${pub.orderSizes?.CASH?.join(',')} | ${pub.orderSizes?.UPI_BANK?.join(',')} | ${pub.usdtBuy?.minUsdt}-${pub.usdtBuy?.maxUsdt}`;
      check(A, 'player', 'the player panel is told the sizes on offer and the USDT bounds', '1000,5000,10000 | 50000,500000 | 200-5000',
        shown, shown === '1000,5000,10000 | 50000,500000 | 200-5000',
        '§2: the SIZES are one policy read from either end — a panel with its own list offers what the gate refuses');
    } finally {
      await PUT(aT, '/api/admin/system/config', {
        orderSizes: before.orderSizes ?? [500, 1000, 5000, 10000, 50000, 100000, 500000], // schema default: all seven
        usdtBuy: before.usdtBuy ?? { minUsdt: 100, maxUsdt: 10000 },                     // schema default
      });
    }
  }

  // ══ 3. USDT pricing: the rate the player is quoted ═══════════════════════
  // §32 S19 names this one directly: the USDT scenario used to READ whatever
  // rate the database happened to hold. Setting it through the route a human
  // would use turns a dead ambient read into a real cross-panel assertion.
  {
    const before = (await GET(aT, '/api/admin/system/config')).body?.config ?? {};
    try {
      // `userMerchantBuyInr` — the INR price of ONE USDT — is what the spec
      // declares, and §2 says declaring a field there is what makes it
      // editable. A PUT naming anything else is accepted and ignored: the
      // first draft of this case set `tokensPerUsdt` and read back null,
      // which looks exactly like a broken cross-panel path and is in fact a
      // field that does not exist.
      const saved = await PUT(aT, '/api/admin/system/config', {
        usdtPricing: { ...(before.usdtPricing ?? {}), userMerchantBuyInr: 91 },
      });
      check(A, 'admin', 'price the USDT rail at ₹91 per USDT', '200',
        `${saved.status} ${saved.body?.message ?? ''}`, saved.status === 200);

      const pub = await publicConfig();
      // One token is one rupee, so ₹91 per USDT IS 91 tokens per USDT — the
      // same stored number read differently, never a second one (§2).
      check(A, 'player', 'the player panel quotes the rate the admin just set', '91 tokens per USDT',
        String(pub.usdtTokensPerUnit),
        Number(pub.usdtTokensPerUnit) === 91,
        '§25: the quote is the contract, and the panel must not carry its own copy of it');
    } finally {
      if (before.usdtPricing) {
        await PUT(aT, '/api/admin/system/config', { usdtPricing: before.usdtPricing });
      }
    }
  }

  // ══ 4. A supervisor asks for tokens, the admin sells them, the pool shows ═
  // Since Step 2c tokens belong to a TEAM's pool, not to a merchant, and they
  // reach it through a request the supervisor raises and an admin fulfils
  // (`teamPools.js`). Driven over both HTTP routes, and read back through the
  // SUPERVISOR's own pool screen — never the admin's fulfil response.
  //
  // Every member is offline and no other team is touched (`exclusive: false`),
  // so no order can be routed into this pool while the case reads it: the only
  // things that move it are the two requests below.
  {
    const team = await seedTeam({ rail: 'UPI_BANK', online: [], exclusive: false });
    const sT = merchantToken(team.supervisor);
    const poolPath = `/api/merchant/supervisor/teams/${team.teamId}/pool`;
    const read = async () => (await GET(sT, poolPath)).body ?? {};

    const before = await read();
    const had = Number(before.pool?.availablePaise ?? NaN);
    check(A, 'merchant', 'the supervisor can read their team\'s pool', 'a number',
      String(had), Number.isFinite(had));

    const asked = await POST(sT, `/api/merchant/supervisor/teams/${team.teamId}/pool-requests`, {
      direction: 'BUY', tokenAmount: 25000, note: 'e2e cross-panel',
    });
    const buyReq = asked.body?.request;
    check(A, 'merchant', 'the supervisor asks to buy 25,000 tokens for the pool', '201 PENDING',
      `${asked.status} ${buyReq?.status ?? JSON.stringify(asked.body).slice(0, 120)}`,
      asked.status === 201 && buyReq?.status === 'PENDING');
    if (!buyReq?.requestId) return;

    const queue = await GET(aT, '/api/admin/team-pool-requests?status=PENDING');
    const queued = (queue.body?.requests ?? []).some(r => r.requestId === buyReq.requestId);
    check(A, 'admin', 'the admin queue shows the supervisor\'s request', 'present',
      queue.status === 200 ? (queued ? 'present' : 'ABSENT') : `HTTP ${queue.status}`, queued,
      '§32 S17: a request the admin never sees is half a feature');

    const sold = await POST(aT, `/api/admin/team-pool-requests/${buyReq.requestId}/fulfil`, {
      settlementCurrency: 'INR', settlementAmount: 25000,
    });
    check(A, 'admin', 'fulfil the request, recording what was paid', '200',
      `${sold.status} ${sold.body?.message ?? JSON.stringify(sold.body).slice(0, 120)}`, sold.status === 200);

    const after = await read();
    const nowHas = Number(after.pool?.availablePaise ?? NaN);
    check(A, 'merchant', 'the supervisor\'s pool shows the tokens the admin sold', `${had + 2500000} paise`,
      `${nowHas} paise`, nowHas === had + 2500000,
      'trap 19: the recipient is read through its OWN screen, not the sender\'s receipt');
    const sale = (after.entries ?? []).filter(e => e.kind === 'ADMIN_SALE' && e.refId === buyReq.requestId);
    check(A, 'merchant', 'the pool ledger names the sale', 'one ADMIN_SALE +2500000 for the request',
      sale.map(e => `${e.kind} ${e.availableDeltaPaise}`).join('; ') || 'NONE',
      sale.length === 1 && sale[0].availableDeltaPaise === 2500000);
    const buyDone = (after.requests ?? []).find(r => r.requestId === buyReq.requestId);
    check(A, 'merchant', 'the supervisor sees the request fulfilled', 'FULFILLED',
      String(buyDone?.status ?? 'ABSENT'), buyDone?.status === 'FULFILLED');

    // ── And the BUYBACK: the platform takes tokens out of the pool ──────────
    const back = await POST(sT, `/api/merchant/supervisor/teams/${team.teamId}/pool-requests`, {
      direction: 'SELL', tokenAmount: 5000, note: 'e2e cross-panel buyback',
    });
    const sellReq = back.body?.request;
    check(A, 'merchant', 'the supervisor asks the platform to buy 5,000 tokens back', '201 PENDING',
      `${back.status} ${sellReq?.status ?? JSON.stringify(back.body).slice(0, 120)}`,
      back.status === 201 && sellReq?.status === 'PENDING');
    if (!sellReq?.requestId) return;
    const bought = await POST(aT, `/api/admin/team-pool-requests/${sellReq.requestId}/fulfil`, {
      settlementCurrency: 'INR', settlementAmount: 5000,
    });
    check(A, 'admin', 'fulfil the buyback, recording what was paid out', '200',
      `${bought.status} ${bought.body?.message ?? JSON.stringify(bought.body).slice(0, 120)}`, bought.status === 200);
    const end = await read();
    const left = Number(end.pool?.availablePaise ?? NaN);
    check(A, 'merchant', 'the supervisor\'s pool shows the buyback too', `${had + 2000000} paise`,
      `${left} paise`, left === had + 2000000);

    // ── And the MONEY record beside each token movement ─────────────────────
    // A pool that moved with no record of what was paid for it is half a
    // trade: the consideration (`admin_token_considerations`) is the other
    // side, written in the fulfilment's own transaction against the team and
    // its supervisor. Read back from the table, not from the fulfil response.
    const money = (await db.adminTokenConsiderations.listForMerchant(team.supervisor.merchantId))
      .filter((c) => c.teamId === team.teamId);
    const got = money.find((c) => c.direction === 'RECEIVED');
    const paid = money.find((c) => c.direction === 'PAID');
    check(A, 'system', 'each pool movement carries what the platform was paid, or paid', 'RECEIVED ₹25,000 for 25,000 tokens; PAID ₹5,000 for 5,000',
      money.map((c) => `${c.direction} ${c.currency} ${c.fiatAmountMinor} for ${c.tokenAmountPaise}`).join('; ') || 'NO RECORD',
      money.length === 2
        && got?.currency === 'INR' && got.fiatAmountMinor === 2500000 && got.tokenAmountPaise === 2500000
        && paid?.currency === 'INR' && paid.fiatAmountMinor === 500000 && paid.tokenAmountPaise === 500000,
      'trap 19: the sender\'s receipt is not the record — the table is');
  }

  // ══ 5. Admin changes a merchant's CAPABILITIES ═══════════════════════════
  {
    const m = await seedMerchant({ currency: 'INR' });
    const mT = merchantToken(m);

    const set = await PUT(aT, `/api/admin/merchants/${m.merchantId}/capabilities`, {
      acceptsDeposits: false, acceptsWithdrawals: true,
    });
    check(A, 'admin', 'stop a merchant taking deposits', '200',
      `${set.status} ${set.body?.message ?? ''}`, set.status === 200);

    const prof = await GET(mT, '/api/merchant/profile');
    check(A, 'merchant', 'the merchant panel reflects the capability change', 'acceptsDeposits false',
      String(prof.body?.merchant?.acceptsDeposits),
      prof.body?.merchant?.acceptsDeposits === false,
      '§32 S17: an admin decision the merchant never sees is half a feature');

    // The stored flag agrees with the panel. Its consumer is team routing:
    // `teamRouting.routingCandidates` reads it per direction, so a member who
    // stops taking deposits is not routed buys (merchantPanelRoutes, M329).
    const candidate = await pgQuery(
      `SELECT accepts_deposits FROM merchants WHERE merchant_id = $1`, [m.merchantId]);
    check(A, 'system', 'and the stored flag agrees with the panel', 'false',
      String(candidate.rows[0]?.accepts_deposits),
      candidate.rows[0]?.accepts_deposits === false,
      'one owner: the column the admin wrote is the column the panel renders');
  }

  // ══ 6. A merchant goes OFFLINE — the platform stops sending them work ════
  {
    const m = await seedMerchant({ currency: 'INR', online: true });
    const mT = merchantToken(m);

    const off = await PUT(mT, '/api/merchant/online-status', { isOnline: false });
    const online = await pgQuery(
      `SELECT is_online FROM merchants WHERE merchant_id = $1`, [m.merchantId]);
    check(A, 'merchant', 'a merchant can take themselves offline', 'is_online false',
      `${off.status} → ${online.rows[0]?.is_online}`,
      online.rows[0]?.is_online === false,
      'the merchant acts; the PLATFORM has to stop routing to them');
  }

  // ══ 7. Support links: the admin saves, the player panel reads ════════════
  {
    const before = (await GET(aT, '/api/admin/content/support-links')).body?.supportLinks ?? {};
    try {
      const saved = await PUT(aT, '/api/admin/content/support-links', {
        telegram: 'https://t.me/bb_e2e_support',
      });
      check(A, 'admin', 'save a support link', '200',
        `${saved.status} ${saved.body?.message ?? ''}`, saved.status === 200,
        '§32 S25: this screen once kept its own list of fields and had NEVER saved anything');

      // Its OWN route, not the system config. The first draft looked in
      // `/api/v1/system/config` and reported a cross-panel break; support
      // links have never been in that payload and are not meant to be.
      // §29 exactly — a failing check is not evidence when it is pointed at
      // the wrong thing.
      const seen = await GET(null, '/api/v1/content/support-links');
      const links = seen.body?.links ?? {};
      check(A, 'player', 'the player panel is served the link the admin saved',
        'https://t.me/bb_e2e_support', String(links.telegram),
        links.telegram === 'https://t.me/bb_e2e_support',
        'BUG-U19 was this hole: admin-configured channels that reached no player');
    } finally {
      if (before.telegram !== undefined) {
        await PUT(aT, '/api/admin/content/support-links', { telegram: before.telegram });
      }
    }
  }

  // ══ 8. An FAQ the admin publishes is one a player can read ═══════════════
  {
    const made = await POST(aT, '/api/admin/content/faq', {
      question: `e2e cross question ${Date.now()}`,
      answer: 'e2e cross answer',
      isPublished: true,
    });
    check(A, 'admin', 'publish an FAQ', '200/201',
      `${made.status} ${JSON.stringify(made.body).slice(0, 120)}`,
      [200, 201].includes(made.status));

    const seen = await GET(null, '/api/v1/content/faq?isPublished=true');
    const found = JSON.stringify(seen.body ?? {}).includes('e2e cross answer');
    check(A, 'player', 'the player panel can read the published FAQ', 'the answer text',
      found ? 'present' : JSON.stringify(seen.body).slice(0, 160), found,
      'BUG-U9 was this exact hole: admin FAQs that reached no player');
  }
}
