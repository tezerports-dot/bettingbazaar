// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SportsbookProvider.interface.js — Base class for sportsbook/odds integrations.
 *
 * HOW TO ADD A NEW ODDS PROVIDER
 * ───────────────────────────────
 * 1. Create backend/providers/sportsbook/<name>/<Name>Provider.js
 * 2. Extend SportsbookProvider and implement all abstract methods.
 * 3. Register: providerRegistry.sportsbook.register(new BetfairProvider());
 * 4. Gate behind feature flag: isEnabled('SPORTSBOOK')
 */

export class SportsbookProvider {
  get id()          { throw new Error(`${this.constructor.name}: id not implemented`); }
  get displayName() { return this.id; }
  get version()     { return '1.0.0'; }

  /** Disabled by default */
  async isAvailable() { return false; }

  /**
   * Fetch upcoming / live events.
   * @param {string}   sport     e.g. 'cricket', 'football'
   * @param {string}   league    e.g. 'ipl', 'epl'
   * @param {Date}     fromDate
   * @param {Date}     toDate
   * @returns {Promise<Array<{id: string, name: string, startTime: Date, status: string}>>}
   */
  async getEvents(sport, league, fromDate, toDate) {
    throw new Error(`${this.constructor.name}: getEvents not implemented`);
  }

  /**
   * Fetch current odds for an event.
   * @param {string} eventId
   * @returns {Promise<Array<{market: string, selections: Array<{name: string, odds: number}>}>>}
   */
  async getOdds(eventId) {
    throw new Error(`${this.constructor.name}: getOdds not implemented`);
  }

  /**
   * Subscribe to real-time odds updates.
   * Implementation should use SSE, WebSocket, or polling as appropriate.
   * @param {string[]}  eventIds
   * @param {function}  callback  ({ eventId, market, selections, ts }) => void
   * @returns {Promise<{unsubscribe: function}>}
   */
  async subscribeToOddsUpdates(eventIds, callback) {
    throw new Error(`${this.constructor.name}: subscribeToOddsUpdates not implemented`);
  }

  /**
   * Settle a placed bet against the final result.
   * @param {string} betId
   * @param {object} result  { winner: string, score: object }
   * @returns {Promise<{settled: boolean, payout: number}>}
   */
  async settleBet(betId, result) {
    throw new Error(`${this.constructor.name}: settleBet not implemented`);
  }
}
