// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A player is an Aadhaar and a Telegram-linked mobile. Nothing else.
 *
 * ── Why absence needs a test ────────────────────────────────────────────────
 * Every removal in this area is invisible to a feature test. A suite that
 * proves "signup works" passes perfectly well with a dead email field still on
 * the model, an SMTP adapter still declared, and a function that mints writable
 * S3 URLs under a `kyc/` prefix still exported. Those things do not fail — they
 * sit there until somebody wires them back up, and then the platform is
 * collecting identity documents again without a decision ever being taken.
 *
 * So this asserts the shape of what is NOT there.
 *
 * ── The two removals it guards ──────────────────────────────────────────────
 * 1. `User.email` and the EMAIL notification channel. The bot never asks for an
 *    email, so the field was empty for every player who could exist, and the
 *    channel's only reachable answer was "user has no email on file".
 * 2. Every KYC document upload path. The platform collects a NUMBER, verified
 *    in bulk — no ID scan, no address proof, no selfie. The strongest
 *    protection for an identity document is not holding one.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import '../../models/index.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'tests') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const sources = [
  ...walk(join(repo, 'backend')),
  ...walk(join(repo, 'user-panel/src')),
  ...walk(join(repo, 'admin-panel/src')),
];

/** Source text with comments stripped — a removal NOTE must not read as a use. */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('a player has no email', () => {
  it('User declares no email path', () => {
    // The whole point: a declared path is one Mongoose will happily persist, so
    // as long as it exists somebody can write to it and something can read it.
    expect(mongoose.models.User.schema.path('email')).toBeUndefined();
  });

  it('no channel adapter is called EMAIL', async () => {
    const { listChannels } = await import('../../domains/communication/channelRegistry.js');
    expect(listChannels().map((c) => c.code)).not.toContain('EMAIL');
  });

  it('nothing imports nodemailer', () => {
    // It existed only for that adapter. A mail dependency and a set of SMTP
    // credentials carried for a path that cannot fire is cost and attack
    // surface, not optionality.
    const offenders = sources.filter((f) => /nodemailer/.test(code(f)));
    expect(offenders.map((f) => f.replace(repo, ''))).toEqual([]);
  });

  it('is absent from package.json', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('nodemailer');
  });

  it('the profile route takes username and nothing else', () => {
    // An allow-list, deliberately. A `req.body` spread here would let a caller
    // set kycStatus, mobile or a balance — all declared paths, so strict mode
    // would not save us.
    const src = code(join(repo, 'backend/domains/user/user.routes.js'));
    const handler = src.slice(src.indexOf("'/user/:userId/profile'"));
    const body = handler.slice(0, handler.indexOf('findByIdAndUpdate'));
    expect(body).toMatch(/const \{ username \} = req\.body/);
    expect(body).not.toMatch(/updates\.email/);
  });
});

describe('no KYC document can be uploaded, because none is collected', () => {
  it('exports no KYC upload URL generator', async () => {
    const cdn = await import('../../services/cdn.service.js');
    expect(Object.keys(cdn)).not.toContain('generateKYCUploadUrl');
    expect(Object.keys(cdn.default)).not.toContain('generateKYCUploadUrl');
  });

  it('has no code anywhere that presigns under a kyc/ prefix', () => {
    const offenders = sources.filter((f) => /category:\s*[`'"]kyc/i.test(code(f)));
    expect(offenders.map((f) => f.replace(repo, ''))).toEqual([]);
  });

  it('serves no KYC document endpoint', () => {
    const offenders = sources.filter((f) => /kyc\/[^'"`\s]*\/(upload-url|document)/i.test(code(f)));
    expect(offenders.map((f) => f.replace(repo, ''))).toEqual([]);
  });

  it('keeps the upload paths the platform genuinely uses', () => {
    // The inverse assertion, and it matters: "remove the upload routes" is a
    // reasonable-sounding instruction that would break P2P payment proofs,
    // dispute chat attachments and admin branding. Those are live features.
    const cdn = readFileSync(join(repo, 'backend/services/cdn.service.js'), 'utf8');
    for (const kept of ['generateChatUploadUrl', 'generatePaymentProofUploadUrl', 'generateBrandingUploadUrl']) {
      expect(cdn, `${kept} is a live feature and must not be removed`).toContain(`export async function ${kept}`);
    }
  });
});

describe('a failed Aadhaar does not stay held', () => {
  /**
   * `aadhaarHash` is UNIQUE. That is correct while a submission is live and
   * actively harmful once it has failed: a player who mistyped one digit has
   * parked a STRANGER's Aadhaar in that index, and the stranger is then refused
   * at signup with "already registered" for a number they never gave us.
   *
   * Asserted against the source because the behaviour needs a real database to
   * exercise (the integration suite does that); what is pinned here is that the
   * release exists at all, runs in the right order, and is bounded.
   */
  const bulk = readFileSync(join(repo, 'backend/domains/identity/kycBulk.service.js'), 'utf8');

  it('deletes the submission rows a batch failed', () => {
    expect(bulk).toMatch(/releaseFailedSubmissions/);
    expect(bulk).toMatch(/KycVerification\.deleteMany/);
  });

  it('releases only AFTER the verdicts reach the users', () => {
    // syncDecidedUsers finds its work by querying these rows. Deleting first
    // would leave every failed player stuck on PENDING_APPROVAL with nothing
    // left to explain why.
    const sync = bulk.indexOf('await syncDecidedUsers(batchId)');
    const release = bulk.indexOf('releaseFailedSubmissions(batchId)');
    expect(sync).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(sync);
  });

  it('counts failures from the users, not from the deleted rows', () => {
    // Counting KycVerification rows would report zero failures forever.
    expect(bulk).toMatch(/countDocuments\(\{ kycStatus: 'REJECTED' \}\)/);
  });

  it('bounds how many Aadhaar numbers one account may submit', async () => {
    const { MAX_KYC_SUBMISSIONS } = await import('../../domains/telegram/telegramOnboarding.service.js');
    // "Submit a number, be told whether it is registered" is an enumeration
    // oracle if it can be repeated freely.
    expect(MAX_KYC_SUBMISSIONS).toBeGreaterThan(1);
    expect(MAX_KYC_SUBMISSIONS).toBeLessThanOrEqual(5);
  });

  it('declares the attempt counter, so the cap is not silently dropped', () => {
    // kycData already lost `reviewedBy` to exactly this trap.
    expect(mongoose.models.User.schema.path('kycData.submissionCount')).toBeDefined();
  });
});

describe('the scan can actually fail', () => {
  // A detector that cannot report anything is decoration.
  it('reads real source, not an empty list', () => {
    expect(sources.length).toBeGreaterThan(200);
  });

  it('strips comments, so a removal note is not mistaken for a use', () => {
    const withNote = '/* generateKYCUploadUrl was removed */\nconst x = 1;';
    const stripped = withNote.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toContain('generateKYCUploadUrl');
  });
});
