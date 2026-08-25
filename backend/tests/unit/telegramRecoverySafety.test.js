// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Account recovery hands one person's account to a different Telegram identity.
 * That is the exact shape a successful takeover has, so the properties that
 * separate the two are pinned here.
 *
 * Structural, and deliberately so: what matters is WHICH value is used as a
 * search key, whether two factors are both required, and whether failures are
 * distinguishable — none of which a happy-path integration test would notice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const svc = read('../../domains/telegram/telegramRecovery.service.js');
const routes = read('../../domains/telegram/telegram.routes.js');

describe('recovery requires two independent factors', () => {
  it('finds the account by PHONE, never by Aadhaar', () => {
    // Searching by Aadhaar would turn the bot into an oracle for "does this
    // Aadhaar have an account here" — the exact flaw removed from the old
    // recovery route. The Aadhaar is only ever compared to the account the
    // phone already resolved to.
    expect(svc).toMatch(/User\.findOne\(\{ mobile \}\)/);
    expect(svc).not.toMatch(/User\.findOne\(\{[^)]*aadhaar/i);
    expect(svc).not.toMatch(/KycVerification\.findOne\(\{\s*aadhaarHash/);
  });

  it('compares the Aadhaar against that account only', () => {
    expect(svc).toMatch(/KycVerification\.findOne\(\{ userId: user\._id \}\)/);
    expect(svc).toMatch(/candidates\.includes\(kyc\.aadhaarHash\)/);
  });

  it('refuses unless BOTH the account and the Aadhaar match', () => {
    expect(svc).toMatch(/if \(!user \|\| !aadhaarMatches\)/);
  });

  it('honours HMAC rotation when comparing', () => {
    // hashAadhaarCandidates covers retired secrets, so a rotation does not lock
    // every existing player out of recovery.
    expect(svc).toMatch(/hashAadhaarCandidates\(aadhaar\)/);
  });

  it('rejects a forwarded contact card', () => {
    // Otherwise someone could recover an account using a number they do not hold.
    expect(svc).toMatch(/contactUserId\) !== String\(newTelegramUserId\)/);
  });
});

describe('failures are indistinguishable', () => {
  it('returns one reason for every genuine mismatch', () => {
    // "no account on this number" vs "wrong Aadhaar" would let a recycled SIM
    // reveal whether a number is registered, and a leaked Aadhaar list reveal
    // which numbers it belongs to.
    const failures = svc.match(/reason: 'no_match'/g) || [];
    expect(failures.length).toBe(1);
    expect(svc).not.toMatch(/reason: 'wrong_aadhaar'|reason: 'no_account'/);
  });

  it('the bot copy does not leak which factor failed', () => {
    expect(routes).toMatch(/no_match:/);
    expect(routes).not.toMatch(/no account (was )?found|wrong aadhaar|aadhaar (did not|does not) match/i);
  });
});

describe('recovery re-links rather than re-creates', () => {
  it('never creates a User', () => {
    // A fresh account would strand the player's balance and silently break the
    // referral chain beneath them.
    expect(svc).not.toMatch(/User\.create|new User\(/);
  });

  it('retires the old identity and links the new one in one transaction', () => {
    const retireAt = svc.indexOf('contactActive: false');
    const linkAt = svc.indexOf('TelegramIdentity.findOneAndUpdate');
    expect(retireAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(retireAt);
    expect(svc).toMatch(/withTransaction/);
    // Both writes must carry the session, or the transaction is decorative.
    const block = svc.slice(svc.indexOf('withTransaction'), svc.indexOf('outcome ='));
    expect((block.match(/session/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a Telegram account already linked elsewhere', () => {
    // Granting it a second account is the duplicate the design exists to stop.
    expect(svc).toMatch(/11000[\s\S]*?telegram_already_linked/);
  });

  it('reports every grant, since a grant looks like a takeover', () => {
    expect(svc).toMatch(/sendAlert\('account-recovered'/);
  });
});

describe('the recovery bot is isolated from the primary bot', () => {
  it('authenticates on its own secret', () => {
    expect(routes).toMatch(/cfg\?\.recoveryWebhookSecret/);
    expect(routes).toMatch(/secretMatches\(req\.get\('X-Telegram-Bot-Api-Secret-Token'\), cfg\.recoveryWebhookSecret\)/);
  });

  it('replies through the recovery bot, not the primary one', () => {
    const handler = routes.slice(routes.indexOf("'/recovery/webhook'"), routes.indexOf("'/exchange'"));
    expect(handler).toMatch(/sendRecoveryMessage/);
    expect(handler).not.toMatch(/[^y]\bsendMessage\(/);
  });

  it('bounds the in-memory conversation state', () => {
    // An Aadhaar must not sit in memory indefinitely, and /start floods must
    // not grow the map without limit.
    expect(routes).toMatch(/RECOVERY_SESSION_MS/);
    expect(routes).toMatch(/recoverySessions\.clear\(\)/);
  });
});
