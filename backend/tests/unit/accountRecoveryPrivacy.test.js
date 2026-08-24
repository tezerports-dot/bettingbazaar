// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The account-recovery endpoints must not answer "does this Aadhaar have an
 * account here?", and their rate limit must not be one the caller can choose.
 *
 * ── Why this is a source scan ───────────────────────────────────────────────
 * Driving the route needs Mongo, PASETO keys and Redis; the properties being
 * pinned are structural — WHICH value keys the limiter, and whether the handler
 * has a branch that answers differently for a matched Aadhaar. A source scan
 * states those directly and, unlike an end-to-end call, cannot pass by accident
 * because a fixture happened not to match.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * `/auth/recover` replied 404 "No account found with this Aadhaar" when nothing
 * matched and proceeded otherwise, turning the endpoint into an oracle for
 * whether a given national ID gambles here — profiling data that is sensitive on
 * its own. Its rate limit was an in-process Map keyed on the `mobile` field FROM
 * THE REQUEST BODY, so a caller varying that field had no limit at all, and the
 * counters were invisible to the other PM2 workers and lost on restart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Comments explain what the code no longer does, and often quote the very
 * message that was removed. Only what the handler can actually SEND is
 * evidence, so prose is stripped before scanning — otherwise documenting a fix
 * would fail the test that proves it.
 */
function code(path) {
  return readFileSync(join(here, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')                       // block comments
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l))    // line + jsdoc bodies
    .join('\n');
}

const routeSrc = code('../../routes/account-recovery.routes.js');
const securitySrc = code('../../middleware/security.js');
const configSrc = code('../../config/security.config.js');

describe('account recovery does not leak whether an Aadhaar is registered', () => {
  it('never tells the caller that no account matched', () => {
    expect(routeSrc).not.toMatch(/No account found with this Aadhaar/i);
    // The lookup may still MISS — it just must not branch into a different reply.
    expect(routeSrc).toMatch(/aadhaarHash/);
  });

  it('answers a submission with one shared response object', () => {
    // A single `neutral` payload returned on every path is what makes the
    // matched and unmatched cases indistinguishable; two literals would drift.
    expect(routeSrc).toMatch(/const neutral = \{/);
    expect(routeSrc).toMatch(/return res\.json\(neutral\)/);
    expect(routeSrc).toMatch(/res\.json\(neutral\)/);
  });

  it('does not reveal that a review is already open for the account', () => {
    expect(routeSrc).not.toMatch(/already under review/i);
  });

  it('records an unmatched submission instead of dropping it', () => {
    // userId simply stays unset, so a mistyped Aadhaar still reaches a human.
    expect(routeSrc).toMatch(/userId:\s*user\?\._id/);
  });
});

describe('the recovery rate limit is not chosen by the caller', () => {
  it('no longer keys a limiter on a request-body field', () => {
    expect(routeSrc).not.toMatch(/checkRecoveryRateLimit\s*\(/);
    // The in-process Map is gone with it.
    expect(routeSrc).not.toMatch(/recoveryAttempts/);
  });

  it('applies the shared limiter as route middleware on both endpoints', () => {
    expect(routeSrc).toMatch(/import \{ accountRecoveryLimiter \}/);
    expect(routeSrc).toMatch(/'\/auth\/check-aadhaar',\s*accountRecoveryLimiter/);
    expect(routeSrc).toMatch(/'\/auth\/recover',\s*accountRecoveryLimiter/);
  });

  it('keys that limiter on the IP and shares its counters across processes', () => {
    const block = securitySrc.slice(securitySrc.indexOf('export const accountRecoveryLimiter'));
    const limiter = block.slice(0, block.indexOf('});') + 3);
    expect(limiter).toMatch(/keyGenerator:\s*\(req\)\s*=>\s*ipKeyGenerator\(req\.ip\)/);
    // Redis-backed, so the limit is one budget for the whole box.
    expect(limiter).toMatch(/createRateLimitStore\(/);
    expect(limiter).toMatch(/RATE_LIMIT_TIERS\.accountRecovery/);
  });

  it('defines the tier it uses', () => {
    expect(configSrc).toMatch(/accountRecovery:\s*\{\s*windowMs:/);
  });
});
