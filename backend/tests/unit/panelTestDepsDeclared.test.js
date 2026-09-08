// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A panel declares what its tests import. It does not rely on a hoisted peer.
 *
 * ── The failure this exists to stop ─────────────────────────────────────────
 * `@testing-library/react` v16 re-exports `screen`, `waitFor` and `fireEvent`
 * from `@testing-library/dom`, which it lists as a PEER dependency. The user
 * panel imported all three and never declared the package.
 *
 * Locally that works: npm installs the peer, the lockfile records it as
 * `{"dev": true, "peer": true}`, and every typecheck passes. CI installs with
 * `npm ci --legacy-peer-deps`, which skips peer-only entries — 345 packages
 * instead of 352 — so `@testing-library/react` resolved, its re-export did not,
 * and fifteen `TS2305: has no exported member 'screen'` errors landed on test
 * files that had not been touched in months.
 *
 * The admin and merchant panels already declared it. Only the user panel did
 * not, and nothing noticed until a fresh install ran.
 *
 * ── Why a test and not a lint rule ──────────────────────────────────────────
 * The gap is between what the SOURCE imports and what the MANIFEST declares,
 * and it is invisible to any check that runs against an already-populated
 * node_modules — which is every check that runs on a developer's machine. This
 * reads the two files and compares them, so it fails everywhere, including on
 * the machine where the install happens to work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PANELS = ['admin-panel', 'user-panel', 'merchant-panel'];

/**
 * Packages a panel's source imports that must be declared even though another
 * dependency would normally drag them in.
 *
 * `@testing-library/dom` is here because it is a peer of
 * `@testing-library/react`, and `--legacy-peer-deps` refuses to install peers.
 */
const MUST_DECLARE = [
  {
    pkg: '@testing-library/dom',
    // Its exports arrive through the react wrapper's `export *`, so the import
    // specifier to look for is the WRAPPER, not the package itself.
    importedAs: '@testing-library/react',
    why: 're-exports screen/waitFor/fireEvent as a peer; --legacy-peer-deps skips peers',
  },
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?[jt]sx?)$/.test(p)) out.push(p);
  }
  return out;
}

describe('panels declare the packages their tests import', () => {
  for (const panel of PANELS) {
    const manifestPath = join(repo, panel, 'package.json');
    if (!existsSync(manifestPath)) continue;

    it(`${panel}`, () => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const declared = { ...manifest.dependencies, ...manifest.devDependencies };
      const sources = walk(join(repo, panel, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');

      for (const { pkg, importedAs, why } of MUST_DECLARE) {
        if (!sources.includes(`from '${importedAs}'`) && !sources.includes(`from "${importedAs}"`)) continue;
        expect(
          declared[pkg],
          `${panel} imports ${importedAs} but does not declare ${pkg} — ${why}`,
        ).toBeTruthy();
      }
    });
  }

  it('records the peer entry that broke, so a regeneration cannot bring it back', () => {
    // A lockfile entry marked `peer: true` is one `--legacy-peer-deps` will
    // skip. Declaring the package directly is what clears the flag, so this
    // asserts the RESULT of the fix rather than the fix itself — a lockfile
    // regenerated without the manifest change would fail here.
    for (const panel of PANELS) {
      const lockPath = join(repo, panel, 'package-lock.json');
      if (!existsSync(lockPath)) continue;
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const entry = lock.packages?.['node_modules/@testing-library/dom'];
      if (!entry) continue;
      expect(
        entry.peer ?? false,
        `${panel}: @testing-library/dom is a peer-only lockfile entry, which npm ci --legacy-peer-deps will not install`,
      ).toBe(false);
    }
  });
});
