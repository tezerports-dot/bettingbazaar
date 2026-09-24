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
import { pgQuery } from '#db/client.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../seed.js';
import {
  playerToken, merchantToken, adminToken, GET, POST, PUT, check, note, idemKey,
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

  // ══ 2. Order floors and ceilings ═════════════════════════════════════════
  {
    const before = (await GET(aT, '/api/admin/system/config')).body?.config ?? {};
    try {
      await PUT(aT, '/api/admin/system/config', { minDeposit: 600, maxDeposit: 44000 });
      const pub = await publicConfig();
      check(A, 'player', 'the player panel is told the new order floor and ceiling', '600 / 44000',
        `${pub.minDeposit} / ${pub.maxDeposit}`,
        pub.minDeposit === 600 && pub.maxDeposit === 44000,
        '§2: the FLOOR is one policy read from either end — a panel with its own number offers what the gate refuses');
    } finally {
      await PUT(aT, '/api/admin/system/config', {
        minDeposit: before.minDeposit ?? 500, maxDeposit: before.maxDeposit ?? 50000,
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

  // ══ 4. Admin FUNDS a merchant — the merchant's own panel shows the tokens ══
  {
    const m = await seedMerchant({ currency: 'INR', tokensPaise: 0 });
    const mT = merchantToken(m);

    const before = await GET(mT, '/api/merchant/profile');
    const had = Number(before.body?.merchant?.tokenBalance ?? 0);

    const funded = await POST(aT, `/api/admin/merchants/${m.merchantId}/fund`, {
      tokenAmount: 25000, settlementAmount: 25000, settlementCurrency: 'INR',
      note: 'e2e cross-panel',
    }, idemKey());
    check(A, 'admin', 'fund a merchant with 25,000 tokens', '200',
      `${funded.status} ${JSON.stringify(funded.body).slice(0, 140)}`, funded.status === 200,
      '§32 S26: this route REQUIRES an Idempotency-Key and answers 400 without one');

    const after = await GET(mT, '/api/merchant/profile');
    const now = Number(after.body?.merchant?.tokenBalance ?? 0);
    check(A, 'merchant', 'the merchant panel shows the tokens the admin sent', `${had + 25000}`,
      String(now), now === had + 25000,
      'trap 19: a 404 is not a rollback — the recipient is read BEFORE the record says they received');

    // ── And the DEDUCT, which had never once worked from the panel ────────
    // A REASON is required and the route says so — taking tokens back off a
    // merchant without one would leave an audit trail nobody can read. The
    // first draft omitted it and got a 400 naming exactly what was missing,
    // which is the refusal working (§32 S14: actionable).
    const ded = await POST(aT, `/api/admin/merchants/${m.merchantId}/deduct`, {
      tokenAmount: 5000, settlementAmount: 5000, settlementCurrency: 'INR',
      reason: 'e2e cross-panel deduction',
    }, idemKey());
    check(A, 'admin', 'deduct 5,000 tokens, with the reason the route demands', '200',
      `${ded.status} ${JSON.stringify(ded.body).slice(0, 140)}`, ded.status === 200,
      '§32 S26: the call has to carry what the handler REQUIRES, not just hit the path');

    const end = await GET(mT, '/api/merchant/profile');
    check(A, 'merchant', 'the merchant panel shows the deduction too', `${had + 20000}`,
      String(end.body?.merchant?.tokenBalance),
      Number(end.body?.merchant?.tokenBalance) === had + 20000);
  }

  // ══ 5. Admin changes a merchant's CAPABILITIES ═══════════════════════════
  {
    const m = await seedMerchant({ currency: 'INR', tokensPaise: 100000000 });
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

    const candidate = await pgQuery(
      `SELECT accepts_deposits FROM merchants WHERE merchant_id = $1`, [m.merchantId]);
    check(A, 'system', 'and the assignment side agrees with the panel', 'false',
      String(candidate.rows[0]?.accepts_deposits),
      candidate.rows[0]?.accepts_deposits === false,
      'one owner: the column the query filters on is the column the panel renders');
  }

  // ══ 6. A merchant goes OFFLINE — the platform stops sending them work ════
  {
    const m = await seedMerchant({ currency: 'INR', tokensPaise: 100000000, online: true });
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
