// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Where the token supply is, holder by holder — Admin › Token Flow
 * (owner, 2026-10-17: "show the total 20 billion pool, then who holds how
 * much: users, merchants, members, admin").
 *
 * Read only, owning no value (§2): every figure is read from its owner.
 *   supply            `bb_token_supply_paise()`, the same function the
 *                     supply-ceiling trigger asks;
 *   platform holding  the supply minus what TOKEN_SUPPLY has released;
 *   platform accounts the other treasury accounts (house reserve and pools);
 *   team pools        `team_pools`, per team: AGENT teams (a supervisor and
 *                     members; a member's commission share is a record, the
 *                     tokens stay in the team's pool, §26) and merchant
 *                     accounts (DIRECT teams);
 *   wallets           `bb_wallet_value_paise`, per account, by account type.
 * Owner, 2026-10-22: General (promotional) balances and escrow are their own
 * holders. A pool's `held_paise` (open orders) and a wallet's `locked_paise`
 * (bets and sells) are ESCROW; a wallet's `promo_paise` is GENERAL; the rest
 * of a wallet is its account type's. So one account can appear under more
 * than one kind, each token still under exactly one.
 * Every token is in exactly one of these places (schema.sql, "TOKEN
 * CONSERVATION"), so the holders add up to the supply; `accountedFor` says
 * whether they do on this read.
 */
import { pgQuery } from '../client.js';
import { paiseToRupees } from '../../backend/shared/money.js';

/** Holder kinds, in the order the screen lists them. */
export const HOLDER_KINDS = Object.freeze([
  'PLATFORM', 'PLATFORM_ACCOUNT', 'TEAM', 'MERCHANT_ACCOUNT', 'PLAYER', 'GENERAL', 'ESCROW', 'MERCHANT_WALLET', 'STAFF_WALLET',
]);

/** How many holders one CSV export may carry. */
export const HOLDERS_EXPORT_MAX = 200_000;

const HOLDERS_SQL = `
  SELECT 'PLATFORM'::text AS kind, 'PLATFORM_HOLDING'::text AS holder_id,
         'Platform holding (not yet released)'::text AS name, NULL::text AS owner,
         bb_token_supply_paise()
           + COALESCE((SELECT balance_paise FROM treasury_accounts WHERE account = 'TOKEN_SUPPLY'), 0) AS tokens_paise,
         NULL::int AS members
  UNION ALL
  SELECT 'PLATFORM_ACCOUNT', a.account, a.account, NULL, a.balance_paise, NULL
    FROM treasury_accounts a
   WHERE a.account NOT IN ('TOKEN_SUPPLY', 'USER_FLOAT', 'TEAM_FLOAT') AND a.balance_paise <> 0
  UNION ALL
  SELECT CASE t.kind WHEN 'DIRECT' THEN 'MERCHANT_ACCOUNT' ELSE 'TEAM' END,
         t.team_id, t.name, COALESCE(sup.name, own.name), tp.available_paise,
         (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.team_id AND tm.status = 'APPROVED')
    FROM team_pools tp
    JOIN teams t ON t.team_id = tp.team_id
    LEFT JOIN merchants sup ON sup.merchant_id = t.supervisor_id
    LEFT JOIN merchants own ON own.merchant_id = t.owner_merchant_id
   WHERE tp.available_paise > 0
  UNION ALL
  SELECT 'ESCROW', t.team_id, t.name, 'held for open orders', tp.held_paise, NULL
    FROM team_pools tp JOIN teams t ON t.team_id = tp.team_id
   WHERE tp.held_paise > 0
  UNION ALL
  SELECT CASE u.account_type WHEN 'MERCHANT' THEN 'MERCHANT_WALLET' WHEN 'STAFF' THEN 'STAFF_WALLET' ELSE 'PLAYER' END,
         w.user_id, COALESCE(u.username, w.user_id), NULL,
         bb_wallet_value_paise(w) - w.locked_paise - w.promo_paise, NULL
    FROM wallets w
    LEFT JOIN users u ON u.user_id = w.user_id
   WHERE bb_wallet_value_paise(w) - w.locked_paise - w.promo_paise > 0
  UNION ALL
  SELECT 'GENERAL', w.user_id, COALESCE(u.username, w.user_id), NULL, w.promo_paise, NULL
    FROM wallets w
    LEFT JOIN users u ON u.user_id = w.user_id
   WHERE w.promo_paise > 0
  UNION ALL
  SELECT 'ESCROW', w.user_id, COALESCE(u.username, w.user_id), 'riding on bets and sells', w.locked_paise, NULL
    FROM wallets w
    LEFT JOIN users u ON u.user_id = w.user_id
   WHERE w.locked_paise > 0`;

const toHolder = (r, supplyPaise) => ({
  kind: r.kind,
  holderId: r.holder_id,
  name: r.name,
  owner: r.owner,
  tokens: paiseToRupees(Number(r.tokens_paise)),
  members: r.members == null ? null : Number(r.members),
  /** Percent of the whole supply, to 6 places. */
  sharePercent: supplyPaise > 0 ? Number(((Number(r.tokens_paise) / supplyPaise) * 100).toFixed(6)) : 0,
});

/**
 * The supply, a total per holder kind, and one page of holders (largest
 * first), in one statement so the page and the totals describe one instant.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.kind]   one of HOLDER_KINDS, or null for all
 * @param {string|null} [opts.search] part of a holder's name or id
 */
export async function tokenHolders({ kind = null, search = null, page = 1, limit = 50, exportAll = false } = {}) {
  if (kind != null && kind !== '' && !HOLDER_KINDS.includes(kind)) {
    throw Object.assign(new Error(`Unknown holder kind. Known: ${HOLDER_KINDS.join(', ')}`), { status: 400, code: 'UNKNOWN_HOLDER_KIND' });
  }
  const params = [kind || null];
  const needle = search == null ? '' : String(search).trim();
  params.push(needle ? `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null);
  const size = exportAll ? HOLDERS_EXPORT_MAX : Math.min(Math.max(Number(limit) || 50, 1), 200);
  const wanted = exportAll ? 1 : Math.max(Number(page) || 1, 1);
  params.push(size, (wanted - 1) * size);

  const { rows } = await pgQuery(
    `WITH h AS MATERIALIZED (${HOLDERS_SQL}),
     s AS (
       SELECT bb_token_supply_paise()::text AS supply_paise,
              (SELECT COALESCE(SUM(tokens_paise), 0) FROM h)::text AS accounted_paise,
              (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
                 SELECT kind, COUNT(*)::int AS holders, SUM(tokens_paise)::text AS tokens_paise
                   FROM h GROUP BY kind) x) AS kinds,
              (SELECT COUNT(*)::int FROM h
                WHERE ($1::text IS NULL OR kind = $1)
                  AND ($2::text IS NULL OR name ILIKE $2 OR holder_id ILIKE $2 OR owner ILIKE $2)) AS matching
     )
     SELECT s.*, pg.*
       FROM s
       LEFT JOIN LATERAL (
         SELECT * FROM h
          WHERE ($1::text IS NULL OR kind = $1)
            AND ($2::text IS NULL OR name ILIKE $2 OR holder_id ILIKE $2 OR owner ILIKE $2)
          ORDER BY tokens_paise DESC, holder_id
          LIMIT $3 OFFSET $4
       ) pg ON TRUE
      ORDER BY pg.tokens_paise DESC NULLS LAST, pg.holder_id`,
    params, 'token_holders',
  );
  const first = rows[0];
  const supplyPaise = Number(first.supply_paise);
  const accountedPaise = Number(first.accounted_paise);
  const byKind = new Map((first.kinds || []).map((k) => [k.kind, k]));
  return {
    supply: paiseToRupees(supplyPaise),
    accountedFor: accountedPaise === supplyPaise,
    accounted: paiseToRupees(accountedPaise),
    kinds: HOLDER_KINDS.map((k) => {
      const x = byKind.get(k);
      const tokensPaise = Number(x?.tokens_paise ?? 0);
      return {
        kind: k,
        holders: Number(x?.holders ?? 0),
        tokens: paiseToRupees(tokensPaise),
        sharePercent: supplyPaise > 0 ? Number(((tokensPaise / supplyPaise) * 100).toFixed(6)) : 0,
      };
    }),
    holders: rows.filter((r) => r.holder_id != null).map((r) => toHolder(r, supplyPaise)),
    total: Number(first.matching),
    page: wanted,
    limit: size,
  };
}
