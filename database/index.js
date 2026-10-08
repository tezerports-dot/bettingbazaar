// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * database/index.js — THE data layer's public API.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE RULE
 * ══════════════════════════════════════════════════════════════════════════
 * Nothing outside this folder writes SQL, opens a connection, or knows a
 * table name. The application imports from here — `import { db } from '#db'`
 * — and gets a namespaced surface: `db.wallets`, `db.orders`, `db.merchants`.
 *
 * That boundary is the point of the folder. When the storage engine, the
 * schema or a repository's internals change, the change stops at this file:
 * every caller keeps the same names. `npm run check:db-boundary` enforces it,
 * so a route that reaches past this API fails the build rather than being
 * found later.
 *
 * PostgreSQL is the only datastore. There is no second store, no mirror, no
 * dual write, no authority resolver.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT LIVES WHERE
 * ══════════════════════════════════════════════════════════════════════════
 *   database/schema.sql        every table, constraint, index and trigger
 *   database/client.js         the pool, `query`, transactions, `applySchema`
 *   database/spec/             contracts enforced in code (configuration)
 *   database/repositories/     one module per domain; the only SQL in the repo
 *   database/migrations/       schema changes that are not idempotent CREATEs
 *
 * A repository named `x.core.js` is the mechanism (locking, movement,
 * transitions) and `x.js` is the vocabulary the application speaks. Both are
 * re-exported here under one namespace, because a caller should not have to
 * know which layer a function came from.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MONEY RULES THAT DO NOT BEND
 * ══════════════════════════════════════════════════════════════════════════
 *  1. Integer paise in BIGINT. Never a float, never a decimal string in
 *     arithmetic. `paiseToRupees` is a display conversion at the boundary.
 *  2. BIGINT arrives from node-postgres as a STRING. Cast where the row is
 *     read, once. Uncast, `'900' >= 1000` is true and every comparison is wrong.
 *  3. Row-level locking (`SELECT … FOR UPDATE`) around every balance mutation.
 *  4. An append-only, double-entry ledger. A balance never moves unaudited.
 *  5. `tx_id` UNIQUE is the idempotency gate — inside the transaction, never a
 *     pre-read a concurrent caller can pass simultaneously.
 *  6. Counters are RECONSTRUCTED from rows, never accumulated in memory.
 *  7. Every balance read is DISPLAY or DECISION. A decision read goes through
 *     the wallet, under the lock that the write takes.
 */

// ── Connection and schema ───────────────────────────────────────────────────
export {
  getPool, pgQuery as query, connectGuarded, applySchema, closePg as close,
  pgConfigured as isConfigured,
} from './client.js';

// ── Namespaced repositories ─────────────────────────────────────────────────
import * as users from './repositories/users.js';
import * as identity from './repositories/identity.js';
import * as telegram from './repositories/telegram.js';
import * as ipBlocks from './repositories/ipBlocks.js';
import * as merchants from './repositories/merchants.js';
import * as chat from './repositories/chat.js';
import * as config from './repositories/config.js';
import * as balanceAdjustments from './repositories/balanceAdjustments.js';
import * as markets from './repositories/markets.js';
import * as games from './repositories/games.js';
import * as content from './repositories/content.js';
import * as androidReleases from './repositories/androidReleases.js';
import * as engagement from './repositories/engagement.js';
import * as social from './repositories/social.js';
import * as referrals from './repositories/referrals.js';
import * as promo from './repositories/promo.js';
import * as boardRules from './repositories/boardRules.js';
import * as boards from './repositories/boards.js';
import * as audit from './repositories/audit.js';
import * as operations from './repositories/operations.js';
import * as supportDocuments from './repositories/supportDocuments.js';
import * as depositPolicy from './repositories/depositPolicy.js';
import * as teams from './repositories/teams.js';
import * as teamPools from './repositories/teamPools.js';
import * as teamCommission from './repositories/teamCommission.js';
import * as teamRouting from './repositories/teamRouting.js';
import * as teamOversight from './repositories/teamOversight.js';
import * as disputeFaults from './repositories/disputeFaults.js';
import * as stats from './repositories/stats.js';
import * as utr from './repositories/utr.js';

import * as walletsCore from './repositories/wallets.core.js';
import * as walletsApi from './repositories/wallets.js';
import * as ledgerCore from './repositories/ledger.core.js';
import * as ledgerApi from './repositories/ledger.js';
import * as ordersCore from './repositories/orders.core.js';
import * as ordersApi from './repositories/orders.js';
import * as ordersRecord from './repositories/orders.record.js';
import * as betsCore from './repositories/bets.core.js';
import * as betsApi from './repositories/bets.js';
import * as casinoCore from './repositories/casino.core.js';
import * as casinoApi from './repositories/casino.js';
import * as bonusesCore from './repositories/bonuses.core.js';
import * as bonusesApi from './repositories/bonuses.js';

import * as settlements from './repositories/settlements.js';
import * as treasury from './repositories/treasury.js';
import * as adminTokenConsiderations from './repositories/adminTokenConsiderations.js';

/** Mechanism + vocabulary under one name. The caller does not need the split. */
const merge = (core, api) => Object.freeze({ ...core, ...api });

export const db = Object.freeze({
  // Identity and access
  users,
  identity,
  ipBlocks,
  telegram,

  // Money
  wallets: merge(walletsCore, walletsApi),
  ledger: merge(ledgerCore, ledgerApi),
  treasury,
  adminTokenConsiderations,
  balanceAdjustments,

  // Trading
  markets,
  bets: merge(betsCore, betsApi),
  settlements,
  casino: merge(casinoCore, casinoApi),
  bonuses: merge(bonusesCore, bonusesApi),

  // Payments and counterparties
  orders: Object.freeze({ ...ordersCore, ...ordersApi, ...ordersRecord }),
  merchants,
  utr,

  // Compliance
  audit,

  // Catalogue and content
  games,
  content,
  androidReleases,

  // Player-facing everything else
  engagement,
  social,
  referrals,
  promo,
  boardRules,
  boards,
  chat,

  // Platform
  config,
  depositPolicy,
  teams,
  teamPools,
  teamCommission,
  teamRouting,
  teamOversight,
  disputeFaults,
  operations,
  supportDocuments,
  stats,
});

export default db;

// Named re-exports for the call sites that read better without the namespace.
export { users, identity, ipBlocks, telegram, merchants, chat, config };
export { treasury, settlements, balanceAdjustments };
export { adminTokenConsiderations };
export { markets, games, content, androidReleases, engagement, social, referrals };
export { audit, teams, depositPolicy, operations, supportDocuments, stats, utr };
