// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
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
import * as security from './repositories/security.js';
import * as telegram from './repositories/telegram.js';
import * as merchants from './repositories/merchants.js';
import * as chat from './repositories/chat.js';
import * as config from './repositories/config.js';
import * as balanceAdjustments from './repositories/balanceAdjustments.js';
import * as markets from './repositories/markets.js';
import * as games from './repositories/games.js';
import * as content from './repositories/content.js';
import * as engagement from './repositories/engagement.js';
import * as social from './repositories/social.js';
import * as referrals from './repositories/referrals.js';
import * as audit from './repositories/audit.js';
import * as compliance from './repositories/compliance.js';
import * as operations from './repositories/operations.js';
import * as paymentConfig from './repositories/paymentConfig.js';
import * as supportDocuments from './repositories/supportDocuments.js';

import * as walletsCore from './repositories/wallets.core.js';
import * as walletsApi from './repositories/wallets.js';
import * as ledgerCore from './repositories/ledger.core.js';
import * as ledgerApi from './repositories/ledger.js';
import * as ordersCore from './repositories/orders.core.js';
import * as ordersApi from './repositories/orders.js';
import * as betsCore from './repositories/bets.core.js';
import * as betsApi from './repositories/bets.js';
import * as casinoCore from './repositories/casino.core.js';
import * as casinoApi from './repositories/casino.js';
import * as bonusesCore from './repositories/bonuses.core.js';
import * as bonusesApi from './repositories/bonuses.js';
import * as kycCore from './repositories/kyc.core.js';
import * as kycApi from './repositories/kyc.js';
import * as merchantWalletsCore from './repositories/merchantWallets.core.js';
import * as merchantWalletsApi from './repositories/merchantWallets.js';

import * as settlements from './repositories/settlements.js';
import * as merchantSettlements from './repositories/merchantSettlements.js';
import * as treasury from './repositories/treasury.js';
import * as adminIssuance from './repositories/adminIssuance.js';

/** Mechanism + vocabulary under one name. The caller does not need the split. */
const merge = (core, api) => Object.freeze({ ...core, ...api });

export const db = Object.freeze({
  // Identity and access
  users,
  identity,
  security,
  telegram,

  // Money
  wallets: merge(walletsCore, walletsApi),
  ledger: merge(ledgerCore, ledgerApi),
  treasury,
  balanceAdjustments,

  // Trading
  markets,
  bets: merge(betsCore, betsApi),
  settlements,
  casino: merge(casinoCore, casinoApi),
  bonuses: merge(bonusesCore, bonusesApi),

  // Payments and counterparties
  orders: merge(ordersCore, ordersApi),
  merchants,
  merchantWallets: merge(merchantWalletsCore, merchantWalletsApi),
  merchantSettlements,
  adminIssuance,
  paymentConfig,

  // Compliance
  kyc: merge(kycCore, kycApi),
  compliance,
  audit,

  // Catalogue and content
  games,
  content,

  // Player-facing everything else
  engagement,
  social,
  referrals,
  chat,

  // Platform
  config,
  operations,
  supportDocuments,
});

export default db;

// Named re-exports for the call sites that read better without the namespace.
export { users, identity, security, telegram, merchants, chat, config };
export { treasury, settlements, merchantSettlements, adminIssuance, balanceAdjustments };
export { markets, games, content, engagement, social, referrals };
export { audit, compliance, operations, paymentConfig, supportDocuments };
