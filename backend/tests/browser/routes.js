// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every screen each panel actually mounts, read out of the panel's own router.
 *
 * ── Why this is derived and not a list ──────────────────────────────────────
 * §28: "a gate whose failure mode is 'the author forgot to update me' reports
 * the author." A hand-written screen list would go stale the first time somebody
 * adds a page, and the pass would report a clean run over a screen it never
 * opened — the worst possible failure for a check whose whole job is to open
 * every screen. So the routes come from the `<Route path="…">` table the panel
 * renders, and the merchant panel's from the `ROUTES` object §8 says its nav and
 * its `<Route>` table share.
 *
 * Wildcards are excluded deliberately: `*` is the catch-all and `/merchant/*` is
 * a redirect out of the panel, so neither is a screen. They are reported as
 * SKIPPED rather than dropped, because "there are 19 routes and I opened 17"
 * needs to be visible.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Blank comments first. An apostrophe in prose is an opening quote to a scanner (§24.6). */
const decomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fromRouteTable(panel) {
  const src = decomment(readFileSync(join(ROOT, panel, 'src', 'App.tsx'), 'utf8'));
  const paths = [...src.matchAll(/<Route\s[^>]*path="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) return null;
  return [...new Set(paths)];
}

function fromRoutesConstant(panel) {
  const src = decomment(readFileSync(join(ROOT, panel, 'src', 'constants.ts'), 'utf8'));
  const block = src.match(/ROUTES\s*(?::[^=]*)?=\s*\{([\s\S]*?)\n\}/);
  if (!block) return null;
  const paths = [...block[1].matchAll(/:\s*'(\/[^']*)'/g)].map((m) => m[1]);
  return paths.length ? [...new Set(paths)] : null;
}

const SKIP = (p) => p === '*' || p.includes('*') || p.includes(':');

/**
 * @returns {{panel: string, screens: string[], skipped: string[], source: string}[]}
 */
export function panelScreens() {
  const out = [];
  for (const [panel, read, source] of [
    ['user-panel',     fromRouteTable,     'App.tsx <Route path>'],
    ['admin-panel',    fromRouteTable,     'App.tsx <Route path>'],
    ['merchant-panel', fromRoutesConstant, 'constants.ts ROUTES'],
  ]) {
    const all = read(panel);
    // A panel whose routes cannot be read is a FAILURE, not an empty list. A
    // silent zero here reads exactly like a clean pass over nothing (§24.6).
    if (!all) throw new Error(`browser pass: could not read ${panel}'s routes from ${source}`);
    out.push({
      panel, source,
      screens: all.filter((p) => !SKIP(p)),
      skipped: all.filter(SKIP),
    });
  }
  return out;
}
