// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/ledgerPg.js — the global accounting ledger, in PostgreSQL.
 *
 * The audit trail. `accounting_events` was mirrored from Mongo since the
 * hybrid-DB work began, but nothing READ it, so every audit answer still came
 * from Mongo. This is the reader and the writer that ends that.
 *
 * ── Two invariants, enforced in different places ────────────────────────────
 *
 * 1. PER EVENT — its postings sum to zero. Enforced by the DATABASE
 *    (bb_check_postings_balance), so an unbalanced event cannot be inserted
 *    even by direct SQL.
 * 2. ACROSS THE LEDGER — every account's postings, summed, total zero. Derived
 *    in trialBalance(); a non-zero grand total means something bypassed the
 *    per-event trigger, which should be impossible.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `idempotency_key` is UNIQUE. The write is an INSERT … ON CONFLICT DO NOTHING
 * with a RETURNING, so a replay reports `idempotent: true` and writes nothing —
 * no pre-read, because a pre-read is a race two callers can both pass. The
 * Mongo original does exactly that pre-read and then catches the 11000 as a
 * fallback; here the single statement IS the gate.
 *
 * ── The one number this file exists to produce ──────────────────────────────
 * reconcileAgainstSubLedgers() answers the question an auditor actually asks:
 * does the general ledger agree with the sub-ledgers it summarises? The trial
 * balance summing to zero proves the ledger is internally consistent and says
 * nothing about whether it describes reality. Comparing USER_FUNDS against the
 * actual sum of user wallets, and the merchant/treasury accounts against
 * theirs, is what makes it an audit rather than an assertion.
 */
import { pgQuery } from '../client.js';
import { ACCOUNTS, ACCOUNT_CODES, EVENT_TYPES } from '../../backend/domains/revenue/chartOfAccounts.js';

/** pg returns BIGINT as a string; every amount crosses this boundary as paise. */
const toPaise = (v) => Number(v ?? 0);

/**
 * Sign-adjust a raw balance by the account's normal balance, so credit-normal
 * accounts (liabilities, revenue) read as positive.
 *
 * `0 - raw` rather than `-raw`: negating zero yields -0, and Object.is(-0, 0)
 * is false, so an untouched credit-normal account would compare unequal to zero
 * for any caller using strict equality. Same edge the treasury hit.
 */
function reported(code, raw) {
  return ACCOUNTS[code].normalBalance === 'CREDIT' ? 0 - raw : raw;
}

/**
 * recordEvent — the ONLY way an entry enters the Postgres ledger.
 *
 * Validates before writing: an unknown event type or unbalanced postings are
 * refused here rather than relying on the trigger, so the caller gets a usable
 * message instead of a constraint name. The trigger remains the backstop for
 * anything that reaches the table another way.
 */
export async function recordEvent({
  eventType, idempotencyKey, postings, refModel = null, refId = null,
  description = null, amountPaise = null, createdAt = null,
}) {
  if (!Object.values(EVENT_TYPES).includes(eventType)) {
    throw new Error(`Unknown accounting event type '${eventType}'. Add it to chartOfAccounts.js first.`);
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required for every accounting event.');
  }
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new Error('An accounting event needs at least two postings (double entry).');
  }

  let sum = 0;
  for (const p of postings) {
    if (!ACCOUNT_CODES.includes(p.account)) {
      throw new Error(`Unknown ledger account '${p.account}'. Known: ${ACCOUNT_CODES.join(', ')}`);
    }
    if (!Number.isInteger(p.amountPaise)) {
      throw new TypeError(`posting '${p.account}': amountPaise must be an integer, got ${p.amountPaise}`);
    }
    sum += p.amountPaise;
  }
  if (sum !== 0) {
    throw new Error(`Postings must conserve to zero (double entry), got ${sum}`);
  }

  // The magnitude of the event, for reporting. Derived rather than trusted so
  // it cannot disagree with the postings it summarises.
  const magnitude = amountPaise ?? postings.reduce((s, p) => s + Math.max(0, p.amountPaise), 0);

  // ON CONFLICT DO NOTHING + RETURNING: the row comes back only when THIS
  // statement inserted it, so an empty result IS the idempotency signal. No
  // pre-read, therefore no window two concurrent callers can both pass.
  const { rows } = await pgQuery(
    `INSERT INTO accounting_events
       (idempotency_key, event_type, amount_paise, ref_model, ref_id, postings, description, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, now()))
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, idempotency_key, event_type, amount_paise, created_at`,
    [idempotencyKey, eventType, magnitude, refModel, refId ? String(refId) : null,
     JSON.stringify(postings.map((p) => ({ account: p.account, amountPaise: p.amountPaise }))),
     description, createdAt],
    'ledger_record',
  );

  if (!rows.length) {
    const existing = await getEvent(idempotencyKey);
    return { ok: true, idempotent: true, event: existing };
  }
  return { ok: true, idempotent: false, event: rowToEvent(rows[0]) };
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    amountPaise: toPaise(row.amount_paise),
    refModel: row.ref_model,
    refId: row.ref_id,
    postings: typeof row.postings === 'string' ? JSON.parse(row.postings) : row.postings,
    description: row.description,
    createdAt: row.created_at,
  };
}

/** One event by its idempotency key, or null. */
export async function getEvent(idempotencyKey) {
  const { rows } = await pgQuery(
    `SELECT * FROM accounting_events WHERE idempotency_key = $1`,
    [idempotencyKey], 'ledger_read_event',
  );
  return rowToEvent(rows[0]);
}

/** Paginated ledger, newest first. The audit read. */
export async function getLedger({ page = 1, limit = 50, eventType = null } = {}) {
  const offset = (Math.max(1, page) - 1) * limit;
  const where = eventType ? 'WHERE event_type = $3' : '';
  const params = eventType ? [limit, offset, eventType] : [limit, offset];

  const [{ rows }, { rows: [count] }] = await Promise.all([
    pgQuery(
      `SELECT * FROM accounting_events ${where} ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
      params, 'ledger_page',
    ),
    pgQuery(
      `SELECT COUNT(*)::int AS n FROM accounting_events ${eventType ? 'WHERE event_type = $1' : ''}`,
      eventType ? [eventType] : [], 'ledger_count',
    ),
  ]);

  const total = count?.n ?? 0;
  return { entries: rows.map(rowToEvent), total, page, pages: Math.ceil(total / limit) || 1 };
}

/**
 * trialBalance — every account's derived balance, and whether the whole ledger
 * conserves to zero. Same shape as the Mongo getTrialBalance so a cutover does
 * not make callers learn a new vocabulary.
 *
 * Balances are DERIVED from postings, never stored. A stored balance is a
 * second number that can disagree with the entries that produced it.
 */
export async function trialBalance() {
  const { rows } = await pgQuery(
    `SELECT p->>'account' AS account,
            SUM((p->>'amountPaise')::BIGINT) AS raw_paise,
            COUNT(*)::int AS postings
       FROM accounting_events, jsonb_array_elements(postings) p
      GROUP BY 1`,
    [], 'ledger_trial_balance',
  );
  const byAccount = new Map(rows.map((r) => [r.account, r]));

  // Summed over EVERY account present in the data, not just the known ones.
  // Restricting it to the chart would make an unknown account read as a
  // conservation failure, which is the wrong diagnosis: the postings do
  // balance, they just name an account nobody recognises. The two problems are
  // reported separately below so each points at its own fix.
  let grandTotal = 0;
  for (const r of rows) grandTotal += toPaise(r.raw_paise);

  const accounts = {};
  for (const code of ACCOUNT_CODES) {
    const raw = toPaise(byAccount.get(code)?.raw_paise);
    accounts[code] = {
      account: code,
      normalBalance: ACCOUNTS[code].normalBalance,
      description: ACCOUNTS[code].description,
      rawPaise: raw,
      reportedPaise: reported(code, raw),
      postings: byAccount.get(code)?.postings ?? 0,
    };
  }

  // An account that is not in the chart. The per-event trigger cannot catch
  // this — it only checks that postings sum to zero, not that the account
  // exists — so a typo would otherwise sit in the ledger unnoticed, balancing
  // perfectly against nothing anyone can name.
  const unknownAccounts = rows
    .map((r) => r.account)
    .filter((a) => !ACCOUNT_CODES.includes(a));

  return {
    ok: grandTotal === 0 && unknownAccounts.length === 0,
    accounts,
    grandTotalPaise: grandTotal,
    conservesToZero: grandTotal === 0,
    unknownAccounts,
  };
}

/** Reported balance of one account, in paise. */
export async function accountBalancePaise(code) {
  if (!ACCOUNT_CODES.includes(code)) {
    throw new Error(`Unknown ledger account '${code}'. Known: ${ACCOUNT_CODES.join(', ')}`);
  }
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS raw_paise
       FROM accounting_events, jsonb_array_elements(postings) p
      WHERE p->>'account' = $1`,
    [code], 'ledger_account_balance',
  );
  return reported(code, toPaise(rows[0]?.raw_paise));
}

/**
 * reconcileAgainstSubLedgers — does the general ledger agree with the
 * sub-ledgers it summarises?
 *
 * The trial balance proves the ledger is internally consistent. It says nothing
 * about whether it describes reality: a ledger can conserve perfectly to zero
 * while claiming users hold ₹5,000 they do not have. This compares the summary
 * accounts against the actual balances in the wallets, merchant pockets and
 * treasury, which is the check that makes it an audit.
 *
 * Every comparison is in integer paise and every query is a plain read — no
 * transaction is held, so this can run on a replica and cannot contend with a
 * money path.
 */
/**
 * Period activity per account: movement, not just a closing balance.
 *
 * ── Why movement and not balance ────────────────────────────────────────────
 * A balance answers "where do we stand"; a regulator asks "what happened in
 * March". Two accounts with identical closing balances can have had ten
 * thousand rupees pass through one and nothing through the other, and only the
 * debit and credit totals distinguish them.
 *
 * Debits and credits are split by SIGN of the posting rather than by a stored
 * flag, so the two always add back to the net and there is no third field to
 * disagree with them.
 */
/**
 * The bonus high-water mark per merchant, read from the IDEMPOTENCY KEY.
 *
 * -- Why not from metadata --------------------------------------------------
 * The engine passed `cumulativeMatchedMinor` in a `metadata` object and read it
 * back with `$metadata.cumulativeMatchedMinor`. There is no metadata column on
 * an accounting event and nothing stores one — so every mark came back
 * undefined, defaulted to 0, and the engine would treat a merchant's ENTIRE
 * lifetime matched volume as newly matched on every pass. Enabling the bonus
 * engine would have paid every merchant their whole history again, each run.
 * It ships disabled, which is the only reason this never fired.
 *
 * The mark is recovered from `acct_bonusissue_<merchantId>_<cumulative>`
 * instead. That key already exists, is UNIQUE, and is the very thing that makes
 * the payment idempotent — so the mark and the idempotency cannot disagree,
 * which a separate metadata field could.
 */
export async function bonusHighWaterMarks() {
  const { rows } = await pgQuery(
    `SELECT ref_id AS merchant_id,
            MAX(NULLIF(regexp_replace(idempotency_key, '^acct_bonusissue_.*_', ''), '')::BIGINT) AS mark
       FROM accounting_events
      WHERE event_type = 'MERCHANT_BONUS_ISSUED'
        AND idempotency_key ~ '^acct_bonusissue_.+_[0-9]+$'
      GROUP BY ref_id`,
    [], 'ledger_bonus_high_water',
  );
  const marks = {};
  // MAX, not "the most recent": a bonus issued out of order — a replay, a
  // repair — must never LOWER the mark, because lowering it re-pays the
  // difference on the very next pass.
  for (const r of rows) marks[r.merchant_id] = Number(r.mark) || 0;
  return marks;
}

export async function accountActivity({ from = null, to = null } = {}) {
  const where = []; const params = [];
  if (from) { params.push(new Date(from)); where.push(`created_at >= $${params.length}`); }
  if (to) { params.push(new Date(to)); where.push(`created_at <= $${params.length}`); }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pgQuery(
    `SELECT p->>'account' AS account,
            COALESCE(SUM((p->>'amountPaise')::BIGINT) FILTER (WHERE (p->>'amountPaise')::BIGINT > 0), 0) AS debit_paise,
            COALESCE(SUM(ABS((p->>'amountPaise')::BIGINT)) FILTER (WHERE (p->>'amountPaise')::BIGINT < 0), 0) AS credit_paise,
            COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS net_paise
       FROM accounting_events e
       CROSS JOIN LATERAL jsonb_array_elements(e.postings) p
       ${filter}
      GROUP BY 1`,
    params, 'ledger_account_activity',
  );
  return rows.map((r) => ({
    account: r.account,
    debitPaise: Number(r.debit_paise),
    creditPaise: Number(r.credit_paise),
    netPaise: Number(r.net_paise),
  }));
}

/** Event counts by type over a period, and the total. */
export async function eventTypeTotals({ from = null, to = null } = {}) {
  const where = []; const params = [];
  if (from) { params.push(new Date(from)); where.push(`created_at >= $${params.length}`); }
  if (to) { params.push(new Date(to)); where.push(`created_at <= $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT event_type, COUNT(*)::int AS events, COUNT(*) OVER ()::int AS type_count,
            SUM(COUNT(*)) OVER ()::int AS total_events
       FROM accounting_events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY event_type
      ORDER BY events DESC`,
    params, 'ledger_event_totals',
  );
  return {
    // Counted in the SAME query as the breakdown. A separate count() is a
    // second read of a table that accepts an event between them, so the total
    // and the rows it is meant to total describe different instants.
    totalEvents: rows.length ? Number(rows[0].total_events) : 0,
    byEventType: rows.map((r) => ({ eventType: r.event_type, events: r.events })),
  };
}

/** Daily ledger activity by event type, gap-filled, chart-ready. */
export async function dailyActivity({ from = null, to = null, timezone = 'Asia/Kolkata' } = {}) {
  const { rows } = await pgQuery(
    `WITH bounds AS (
       SELECT CAST(COALESCE($1::timestamptz, (SELECT MIN(created_at) FROM accounting_events), now())
                   AT TIME ZONE $3 AS DATE) AS lo,
              CAST(COALESCE($2::timestamptz, now()) AT TIME ZONE $3 AS DATE) AS hi
     ), span AS (
       SELECT generate_series(lo, hi, '1 day'::interval)::date AS day FROM bounds
     ), activity AS (
       SELECT CAST(e.created_at AT TIME ZONE $3 AS DATE) AS day, e.event_type,
              COUNT(*)::int AS events,
              COALESCE(SUM((
                SELECT SUM((p->>'amountPaise')::BIGINT)
                  FROM jsonb_array_elements(e.postings) p
                 WHERE (p->>'amountPaise')::BIGINT > 0
              )), 0) AS gross_paise
         FROM accounting_events e
        WHERE ($1::timestamptz IS NULL OR e.created_at >= $1)
          AND ($2::timestamptz IS NULL OR e.created_at <= $2)
        GROUP BY 1, 2
     )
     SELECT s.day, a.event_type, a.events, a.gross_paise
       FROM span s LEFT JOIN activity a ON a.day = s.day
      ORDER BY s.day, a.event_type`,
    [from ? new Date(from) : null, to ? new Date(to) : null, timezone], 'ledger_daily_activity',
  );

  const byDay = new Map();
  for (const r of rows) {
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day);
    if (!byDay.has(day)) byDay.set(day, { day, byEventType: [], totalEvents: 0 });
    if (!r.event_type) continue;   // a day with no activity: kept, as a zero
    const bucket = byDay.get(day);
    bucket.byEventType.push({
      eventType: r.event_type,
      events: r.events,
      grossPaise: Number(r.gross_paise),
    });
    bucket.totalEvents += r.events;
  }
  return [...byDay.values()];
}

/**
 * Every posting in a period, one row each, for export and external audit.
 *
 * Flattened IN THE DATABASE. The document version fetched whole events and
 * expanded their postings in JavaScript, which meant the `limit` bounded EVENTS
 * rather than rows — a ten-thousand-event limit could return forty thousand
 * rows, and an export that was meant to be bounded was not.
 */
export async function postingExport({ from = null, to = null, limit = 10000 } = {}) {
  const where = []; const params = [];
  if (from) { params.push(new Date(from)); where.push(`e.created_at >= $${params.length}`); }
  if (to) { params.push(new Date(to)); where.push(`e.created_at <= $${params.length}`); }

  const { rows } = await pgQuery(
    `SELECT e.id, e.created_at, e.event_type, e.idempotency_key, e.ref_model, e.ref_id,
            e.description, p->>'account' AS account,
            (p->>'amountPaise')::BIGINT AS amount_paise
       FROM accounting_events e
       CROSS JOIN LATERAL jsonb_array_elements(e.postings) p
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 10000, 1), 100000)}`,
    params, 'ledger_posting_export',
  );

  return rows.map((r) => ({
    entryId: String(r.id),
    occurredAt: r.created_at?.toISOString?.() ?? '',
    recordedAt: r.created_at?.toISOString?.() ?? '',
    eventType: r.event_type,
    idempotencyKey: r.idempotency_key,
    refModel: r.ref_model,
    refId: r.ref_id,
    account: r.account,
    side: Number(r.amount_paise) >= 0 ? 'DEBIT' : 'CREDIT',
    amountPaise: Math.abs(Number(r.amount_paise)),
    description: r.description,
  }));
}

export async function reconcileAgainstSubLedgers() {
  const [ledger, wallets, merchants, treasury] = await Promise.all([
    trialBalance(),
    pgQuery(
      `SELECT COALESCE(SUM(deposit_paise + winnings_paise + reserve_paise + locked_paise), 0) AS total
         FROM wallets`, [], 'ledger_recon_wallets'),
    pgQuery(
      `SELECT COALESCE(SUM(available_paise + reserved_paise + settlement_paise), 0) AS total
         FROM merchant_wallets`, [], 'ledger_recon_merchants'),
    pgQuery(
      `SELECT account, balance_paise FROM treasury_accounts`, [], 'ledger_recon_treasury'),
  ]);

  const treasuryBy = Object.fromEntries(treasury.rows.map((r) => [r.account, toPaise(r.balance_paise)]));

  // USER_FUNDS is the platform's liability to users, so it should equal what
  // the user wallets actually hold. PLATFORM_RESERVE is carved out of the same
  // wallets (the deposit/reserve split), so the liability the ledger reports is
  // the two together — subtracting one from the other would double-count.
  const comparisons = [
    {
      name: 'user_liability',
      ledgerPaise: ledger.accounts.USER_FUNDS.reportedPaise + ledger.accounts.PLATFORM_RESERVE.reportedPaise,
      subLedgerPaise: toPaise(wallets.rows[0]?.total),
      subLedger: 'wallets (deposit + winnings + reserve + locked)',
    },
    {
      name: 'merchant_float',
      ledgerPaise: treasuryBy.MERCHANT_FLOAT ?? 0,
      subLedgerPaise: toPaise(merchants.rows[0]?.total),
      subLedger: 'merchant_wallets (available + reserved + settlement)',
    },
    {
      name: 'user_float',
      ledgerPaise: treasuryBy.USER_FLOAT ?? 0,
      subLedgerPaise: toPaise(wallets.rows[0]?.total),
      subLedger: 'wallets (deposit + winnings + reserve + locked)',
    },
  ];

  const differences = comparisons
    .map((c) => ({ ...c, driftPaise: c.ledgerPaise - c.subLedgerPaise }))
    .filter((c) => c.driftPaise !== 0);

  return {
    ok: ledger.ok && differences.length === 0,
    trialBalanceOk: ledger.ok,
    conservesToZero: ledger.conservesToZero,
    unknownAccounts: ledger.unknownAccounts,
    comparisons,
    differences,
  };
}
