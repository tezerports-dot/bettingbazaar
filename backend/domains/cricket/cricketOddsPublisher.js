// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketOddsPublisher.js — the live odds players see (owner, 2026-10-18).
 * A bet, a claim or a feed event marks its match; once a second every marked
 * match's polls go out as ONE public `cricket_odds` event (REALTIME_EVENTS.md),
 * whatever happened in between. Each player's app works out its own live
 * profit or loss from these pools and odds (a §11 display mirror); the server
 * prices a player's own figure only when they ask for a quote and when they
 * confirm.
 */
import { db } from '#db';

export const PUBLISH_INTERVAL_MS = 1000;

class CricketOddsPublisher {
  constructor() { this.dirty = new Set(); this.timer = null; this.sent = 0; }

  markDirty(matchId) { if (matchId) this.dirty.add(String(matchId)); }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => { this.flush().catch((e) => console.warn('[cricket-odds]', e.message)); }, PUBLISH_INTERVAL_MS);
      this.timer.unref?.();
    }
    return this;
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async flush(sseManager = global.sseManager) {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const matchId of ids) {
      const [match, polls] = await Promise.all([db.cricket.getMatch(matchId), db.cricket.playerPolls(matchId)]);
      if (!match?.published) continue;
      try {
        sseManager?.broadcast?.('cricket_odds', { matchId, status: match.status, score: match.score, toss: match.toss, result: match.result, polls });
        this.sent += 1;
      } catch (e) { console.warn('[cricket-odds] broadcast error:', e.message); }
    }
    return ids.length;
  }
}

export const cricketOddsPublisher = new CricketOddsPublisher();
