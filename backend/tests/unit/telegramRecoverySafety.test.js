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
    expect(svc).toMatch(/getUserByMobile\(mobile\)/);
    // No lookup anywhere takes an Aadhaar as its search key. Asserted over the
    // whole file rather than one expression, so a future read added below is
    // covered too.
    expect(svc).not.toMatch(/getUserBy[A-Za-z]*\([^)]*aadhaar/i);
    expect(svc).not.toMatch(/(findBy|getBy|lookup)[A-Za-z]*[Aa]adhaar/);
  });

  it('compares the Aadhaar against that account only', () => {
    // The verification is fetched BY THE ACCOUNT the phone resolved to, and the
    // Aadhaar is only ever compared to what comes back.
    expect(svc).toMatch(/getVerification\(user\.userId\)/);
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
  it('never creates an account', () => {
    // A fresh account would strand the player's balance and silently break the
    // referral chain beneath them.
    expect(svc).not.toMatch(/createUser\(|User\.create|new User\(/);
  });

  it('stands the old identity down and links the new one in one transaction', () => {
    // The swap is ONE repository call, which is what makes it one transaction.
    // The shape this replaced assembled the two writes here and had to carry a
    // session through both — so a write that forgot the session left the
    // transaction decorative, and nothing in the file said so.
    expect(svc).toMatch(/relinkIdentity\(\{/);
    // And it must not be reassembled out of separate steps.
    expect(svc).not.toMatch(/deactivateContact\([\s\S]*createIdentity\(/);
  });

  it('refuses a Telegram account already linked elsewhere', () => {
    // Granting it a second account is the duplicate the design exists to stop.
    // A RETURNED refusal, not a caught duplicate-key error: the case is a
    // refusal the caller answers with a message, not a fault.
    expect(svc).toMatch(/telegram_already_linked/);
    expect(svc).toMatch(/if \(!linked\.ok\)/);
  });

  it('reports every grant, since a grant looks like a takeover', () => {
    expect(svc).toMatch(/sendAlert\('account-recovered'/);
  });
});

describe('the recovery bot is isolated from the primary bot', () => {
  it('authenticates on its own secret', () => {
    // Asserted over the recovery handler's OWN text rather than against one
    // exact expression, so the secret may be resolved however it needs to be —
    // the config's embedded value, or the recovery bot in the fleet — while the
    // thing that actually matters stays pinned: it must never be the PRIMARY
    // bot's secret, which would let a compromised sign-in bot drive account
    // recovery, the precise separation this whole second bot exists for.
    const handler = routes.slice(routes.indexOf("'/recovery/webhook'"), routes.indexOf("'/public-config'"));
    expect(handler, 'the recovery secret must be a recovery credential').toMatch(/recovery/i);
    expect(handler).toMatch(/secretMatches\(req\.get\('X-Telegram-Bot-Api-Secret-Token'\)/);
    // The exact bypass: authenticating recovery against the primary's secret.
    // Asserted as "the primary secret is not named anywhere in this handler"
    // rather than as a pattern around the comparison — the argument list
    // contains its own parentheses, so any regex trying to span it is one
    // `req.get(...)` away from silently matching nothing. The recovery handler
    // has no legitimate use for `cfg.webhookSecret` at all.
    expect(handler, 'recovery must not accept the primary bot’s secret')
      .not.toMatch(/\bcfg\.webhookSecret\b/);
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
