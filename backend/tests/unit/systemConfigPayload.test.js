// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The system-config payload has exactly one owner, and it reads a legitimate 0.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * This object was assembled twice — Socket.IO on connect, HTTP on request — and
 * the copies had already drifted in both directions: only the socket carried
 * webUrl/androidUrl/iosUrl, only the HTTP route carried kycRequired and
 * registrationEnabled. What a client believed about the platform depended on
 * which transport it asked over.
 *
 * The HTTP copy also wrote `config?.minDeposit || 100` for every numeric limit.
 * `||` cannot tell 0 from absent, so an operator who set a limit to zero was
 * served the default and the panel enforced a floor they had explicitly
 * removed. That is trap 1 and mutation M23 in a third place, which is why the
 * zero case is asserted here rather than assumed.
 *
 * These are absence-and-shape checks. A happy-path test passes perfectly well
 * against two builders that agree today and diverge next week.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { systemConfigPayload, systemConfigFallback } from '../../domains/configuration/systemConfigPayload.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(join(repo, p), 'utf8');

describe('the system-config payload', () => {
  it('gives every consumer the same field set', () => {
    // Both transports render the same object, so a field added for one reaches
    // the other. The two used to differ by five fields.
    const keys = Object.keys(systemConfigPayload(null)).sort();
    for (const gone of ['webUrl', 'androidUrl', 'iosUrl', 'kycRequired', 'registrationEnabled']) {
      expect(keys, `${gone} must be in the one payload, not one transport's copy`).toContain(gone);
    }
    expect(Object.keys(systemConfigFallback()).sort()).toEqual(keys);
  });

  it('reads a limit an operator deliberately set to 0', () => {
    // The whole point of the `??`/`||` distinction. With `||` every one of
    // these silently became the default.
    const zeroed = systemConfigPayload({
      minDeposit: 0, maxDeposit: 0, minWithdrawal: 0, maxWithdrawal: 0,
      payoutMultiplier: 0, betLimits: { thirtyMin: { min: 0, max: 0 }, fullDay: { max: 0 } },
    });
    for (const k of ['minDeposit', 'maxDeposit', 'minWithdrawal', 'maxWithdrawal',
                     'payoutMultiplier', 'minBet', 'maxBet', 'maxFullDayBet']) {
      expect(zeroed[k], `${k}: a configured 0 must survive, not fall back`).toBe(0);
    }
  });

  it('still fills an ABSENT value with its declared default', () => {
    // The other half: `??` must not turn into "pass everything through".
    const empty = systemConfigPayload(null);
    expect(empty.minDeposit).toBe(100);
    expect(empty.minWithdrawal).toBe(500);
    expect(empty.payoutMultiplier).toBe(2);
    expect(empty.minBet).toBe(10);
  });

  it('treats false and empty string as configured, not missing', () => {
    expect(systemConfigPayload({ maintenanceMode: false }).maintenanceMode).toBe(false);
    expect(systemConfigPayload({ maintenanceMessage: '' }).maintenanceMessage).toBe('');
    expect(systemConfigPayload({ kycRequired: false }).kycRequired).toBe(false);
    expect(systemConfigPayload({ registrationEnabled: false }).registrationEnabled).toBe(false);
  });

  it('never hands back an empty footer', () => {
    // An admin cannot intend a panel with no navigation, so [] means unset.
    expect(systemConfigPayload({ footerPages: [] }).footerPages).toHaveLength(5);
    expect(systemConfigPayload({ footerPages: ['home', 'profile'] }).footerPages).toEqual(['home', 'profile']);
  });

  it('does not hand out the array the caller owns', () => {
    // The default list is frozen and shared; returning it directly would let one
    // request's mutation reach every later one.
    const a = systemConfigPayload(null).footerPages;
    a.push('injected');
    expect(systemConfigPayload(null).footerPages).toHaveLength(5);
  });

  it('is assembled in one place — neither consumer builds its own', () => {
    // The regression that matters: someone reintroducing a literal beside the
    // builder is how these drifted the first time.
    for (const f of ['backend/startup/socketHandlers.js', 'backend/domains/user/user.routes.js']) {
      const src = read(f);
      expect(src, `${f} must call the builder`).toMatch(/systemConfigPayload\(/);
      // No second declaration of a default that the builder already owns.
      expect(src, `${f} must not re-declare payoutMultiplier's default`)
        .not.toMatch(/payoutMultiplier:\s*\w+\?\?/);
      expect(src, `${f} must not re-declare minDeposit's default`)
        .not.toMatch(/minDeposit:\s*\w/);
    }
  });
});
