// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * There is no merchant-to-user order chat, and the platform offers no way to
 * start one.
 *
 * ── Why absence needs a test ────────────────────────────────────────────────
 * The player-facing chat was removed and the backend kept serving it: two
 * merchant routes and four upload presigns survived with no screen calling
 * them, invisible to every check because nothing was looking for a feature
 * that should NOT exist. `check:ui-coverage` cannot see this — an endpoint no
 * panel calls is on its triage list, not its failure list, which is right for
 * webhooks and wrong for a channel that was deliberately closed.
 *
 * ── Why the channel is closed ───────────────────────────────────────────────
 * A player submits a UTR as proof of payment; the merchant matches it against
 * their own bank statement and confirms or rejects. They never negotiate. A
 * private channel between the party holding the money and the party owed it is
 * where an off-platform settlement gets agreed — and an off-platform settlement
 * is one the ledger never sees.
 *
 * The one conversation that exists is the DISPUTE chat, between a player and an
 * admin or sub-admin. That is asserted present below, because "remove the
 * chat" is a reasonable-sounding instruction that would take it too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f) => readFileSync(join(repo, f), 'utf8');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?[jt]sx?)$/.test(p)) out.push(p);
  }
  return out;
}

describe('no merchant-to-user order chat', () => {
  it('serves no order-chat route', () => {
    const merchant = read('backend/domains/merchant/merchant.routes.js');
    expect(merchant).not.toMatch(/router\.(get|post)\(\s*['"`]\/chat\/:/);
  });

  it('issues no upload URL for an order-chat attachment', () => {
    // The presigns outlived the routes they fed. An attachment endpoint is a
    // chat endpoint: it posts a message with a file on it.
    const uploads = read('backend/routes/upload.routes.js');
    expect(uploads).not.toMatch(/router\.\w+\(\s*['"`][^'"`]*\/chat\/:orderId/);
  });

  it('has no panel constant pointing at one', () => {
    // A dead URL constant is how this hid: `check:ui-coverage` matched the
    // string in constants.ts and counted the routes as reached, so they never
    // appeared on the unused list either.
    const files = [
      ...walk(join(repo, 'merchant-panel/src')),
      ...walk(join(repo, 'user-panel/src')),
    ];
    const offenders = files.filter((f) => /['"`][^'"`]*\/(api\/)?merchant\/chat\//.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(repo, ''))).toEqual([]);
  });

  it('keeps the dispute chat, which is a different conversation', () => {
    // Between the player and an admin or sub-admin, and the record a dispute is
    // decided from. "Remove the chat" would take this too.
    const disputes = read('backend/domains/disputes/disputeResolution.admin.routes.js');
    expect(disputes).toMatch(/router\.get\(\s*['"`]\/dispute-orders\/:orderId\/chat/);
    expect(disputes).toMatch(/router\.post\(\s*['"`]\/dispute-orders\/:orderId\/chat/);
  });

  it("keeps the order's own timeline, which the dispute is read from", () => {
    // `postSystemMessage` writes what happened to the order — accepted,
    // confirmed, rejected. Deleting the chat repository with the chat would
    // erase the evidence a dispute is settled on.
    const merchant = read('backend/domains/merchant/merchant.routes.js');
    expect(merchant).toMatch(/postSystemMessage/);
    expect(read('database/repositories/chat.js')).toMatch(/export async function postSystemMessage/);
  });

  it('keeps the merchant QR upload, which is not chat', () => {
    // It uploads a merchant's own UPI QR for their profile. It sat next to the
    // chat presigns and is unrelated to them.
    expect(read('backend/routes/upload.routes.js')).toMatch(/merchant\/qr\/upload-url/);
  });
});
