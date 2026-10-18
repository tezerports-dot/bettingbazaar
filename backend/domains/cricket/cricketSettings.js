// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketSettings.js — the one reading of `SystemConfig.cricket` (owner,
 * 2026-10-18; database/spec/config.spec.js, which owns every default). Percent
 * settings become basis points and token settings paise here, once, so no
 * caller repeats the arithmetic.
 */
import { SYSTEM_CONFIG_SPEC } from '#db/spec/config.spec.js';

const SPEC = SYSTEM_CONFIG_SPEC.fields.cricket.fields;
const SEED_SPEC = SPEC.seedRupees.fields;

const pick = (v, decl) => (typeof v === typeof decl.default ? v : decl.default);
const toBp = (percent) => Math.round(Number(percent) * 100);

/** @param {object} cfg the system config (`getSystemConfig()`) */
export function cricketSettingsOf(cfg) {
  const c = cfg?.cricket ?? {};
  const seeds = c.seedRupees ?? {};
  const val = (k) => pick(c[k], SPEC[k]);
  return {
    enabled: val('enabled') === true,
    comingSoon: val('comingSoon') === true,
    spreadBp: toBp(val('spreadPercent')),
    claimMarginBp: toBp(val('claimMarginPercent')),
    rtpBoostBp: toBp(val('rtpBoostPoints')),
    inPlayDelayMs: val('inPlayDelaySec') * 1000,
    claimHoldSec: val('claimHoldSec'),
    nextBallWindowMs: val('nextBallWindowSec') * 1000,
    tossCloseMs: val('tossCloseMinutes') * 60 * 1000,
    momVoidMs: val('momVoidHours') * 60 * 60 * 1000,
    minStakePaise: val('minStakeRupees') * 100,
    maxStakePaise: val('maxStakeRupees') * 100,
    seedPaise: Object.fromEntries(Object.keys(SEED_SPEC).map((k) => [k, pick(seeds[k], SEED_SPEC[k]) * 100])),
  };
}

/** What players are told of the game (sent in the system config payload). */
export function cricketPublicSettings(cfg) {
  const s = cricketSettingsOf(cfg);
  return {
    enabled: s.enabled,
    // The tab stays on screen while the game is off, as a coming-soon page.
    comingSoon: !s.enabled && s.comingSoon,
    minStake: s.minStakePaise / 100,
    maxStake: s.maxStakePaise / 100,
    inPlayDelaySec: s.inPlayDelayMs / 1000,
    claimHoldSec: s.claimHoldSec,
    // The player app works out each position's live value from the broadcast
    // pools with this margin and `winningsFeePercent` (a §11 display mirror of
    // `quoteClaim`); the server's quote is the figure that counts.
    claimMarginPercent: s.claimMarginBp / 100,
  };
}
