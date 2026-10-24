// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The oldest Node this server may run on (owner, 2026-10-24).
 *
 * Node's 21 Oct 2026 security release fixed a Brotli decoder flaw that lets a
 * crafted compressed body run code on the server (CVE-2026-111497), plus TLS,
 * DNS and keep-alive bugs. 22.23.4 is the first fixed 22.x. The Dockerfile pins
 * it and `engines` asks for it; this is the check at boot, so a server left on
 * an older Node says so in the error log and the alert channel instead of
 * running quietly exposed. It warns, it does not refuse: refusing would take
 * the platform down over a patch an operator has to apply anyway.
 *
 * Raise MIN_NODE with the Dockerfile tag in the change that adopts the next
 * security release (§17.1).
 */

export const MIN_NODE = '22.23.4';

const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

/** True when `version` (a `process.version`) is at or above `min`. */
export function nodeIsPatched(version = process.version, min = MIN_NODE) {
  const [a, b] = [parts(version), parts(min)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Say so, once at boot, when this Node is older than the patched one. Never throws. */
export function warnIfNodeUnpatched({ version = process.version, alert = null, log = (l) => console.error(l) } = {}) {
  if (nodeIsPatched(version)) return false;
  const line = `Node ${version} is older than ${MIN_NODE}, which fixes the October 2026 security release `
    + '(a compressed request body can run code on the server). Upgrade Node and restart.';
  try { log(`⚠️  ${line}`); } catch { /* logging must not stop the boot */ }
  try { alert?.('node-runtime-unpatched', line, { version, minimum: MIN_NODE })?.catch?.(() => {}); } catch { /* same */ }
  return true;
}
