// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CasinoProvider.interface.js — Base class for live casino integrations.
 *
 * HOW TO ADD A NEW CASINO PROVIDER
 * ──────────────────────────────────
 * 1. Create backend/providers/casino/<name>/<Name>Provider.js
 * 2. Extend CasinoProvider and implement all abstract methods.
 * 3. Register: providerRegistry.casino.register(new EvolutionProvider());
 * 4. Gate behind feature flag: isEnabled('LIVE_CASINO')
 *
 * SUPPORTED PROVIDERS (implement CasinoProvider for each)
 *   Evolution Gaming  — https://www.evolution.com/
 *   Pragmatic Play    — https://pragmaticplaylive.net/
 *   EZUGI             — https://ezugi.com/
 *   Vivo Gaming       — https://www.vivogaming.com/
 *   TVBet             — https://tvbet.tv/
 */

export class CasinoProvider {
  /** Unique snake_case ID, e.g. 'evolution', 'pragmatic', 'ezugi' */
  get id()          { throw new Error(`${this.constructor.name}: id not implemented`); }
  get displayName() { return this.id; }
  /** 'live' | 'slots' | 'table' | 'fishing' | 'scratch' */
  get type()        { return 'live'; }
  get version()     { return '1.0.0'; }

  /** Disabled by default — enable after integration testing */
  async isAvailable() { return false; }

  /**
   * Authenticate a player and return a provider session token.
   * @param {string} userId    Platform user ID
   * @param {string} currency  e.g. 'INR'
   * @returns {Promise<{token: string, expiresAt: Date}>}
   */
  async authenticate(userId, currency = 'INR') {
    throw new Error(`${this.constructor.name}: authenticate not implemented`);
  }

  /**
   * Return a launch URL for the lobby or a specific game.
   * @param {string}      userId
   * @param {string|null} gameId  Null = full lobby
   * @param {object}      options  { mode: 'real'|'demo', language: 'en', ... }
   * @returns {Promise<{url: string, expiresAt: Date}>}
   */
  async getLobbyUrl(userId, gameId = null, options = {}) {
    throw new Error(`${this.constructor.name}: getLobbyUrl not implemented`);
  }

  /**
   * Get the player's balance on this provider's wallet.
   * @returns {Promise<{balance: number, currency: string}>}
   */
  async getBalance(userId) {
    throw new Error(`${this.constructor.name}: getBalance not implemented`);
  }

  /**
   * Handle provider callbacks (bet results, session close, etc.).
   * Called by the casino webhook route.
   * @param {object} payload  Provider-specific JSON
   * @param {object} headers  Request headers (for signature validation)
   * @returns {Promise<{accepted: boolean}>}
   */
  async handleCallback(payload, headers = {}) {
    throw new Error(`${this.constructor.name}: handleCallback not implemented`);
  }

  /**
   * List available games for lobby rendering.
   * @param {string|null} category  e.g. 'live_roulette', 'live_blackjack'
   * @returns {Promise<Array<{id: string, name: string, thumbnail: string}>>}
   */
  async listGames(category = null) {
    throw new Error(`${this.constructor.name}: listGames not implemented`);
  }
}
