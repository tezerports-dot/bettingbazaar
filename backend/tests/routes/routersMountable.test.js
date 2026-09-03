// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Every router imports, exports a router, and mounts.
 *
 * ── Why this is worth a test of its own ─────────────────────────────────────
 * A route file can be broken in a way no feature test reaches: an import of a
 * module that no longer exists, a named import the module stopped exporting, a
 * top-level call that throws. ESM resolves imports at LINK time, so a missing
 * named export is not a runtime surprise in one handler — it takes the whole
 * file down, and with it every route in it.
 *
 * `server.js` imports all of them, so in production the failure mode is a
 * process that will not boot. That is at least loud. The quiet version is a
 * route file nothing imports any more, rotting until someone wires it back up.
 *
 * This walks the filesystem rather than taking a list, so a NEW route file is
 * covered the moment it exists — a list would have to be remembered.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import express from 'express';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'tests') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.routes\.js$/.test(entry)) out.push(p);
  }
  return out;
}

const ROUTE_FILES = walk(join(repo, 'backend'));

describe('every route file is loadable and mountable', () => {
  it('finds the route files rather than an empty list', () => {
    // A detector that cannot report anything is decoration: if the walk broke,
    // every test below would pass by covering nothing.
    expect(ROUTE_FILES.length).toBeGreaterThan(30);
  });

  it.each(ROUTE_FILES.map((f) => [relative(repo, f), f]))(
    'mounts %s',
    async (_rel, file) => {
      // The import is the assertion. A missing named export, a deleted module
      // or a throwing top-level statement fails right here, naming the file.
      const mod = await import(file);

      // Two legitimate shapes. Most files export a ready router as default; a
      // few export a FACTORY because their handlers close over something only
      // the server can supply (sse.routes.js needs the SSE manager and the
      // cycle generator). A factory cannot be mounted here without inventing
      // those dependencies, and inventing them would test the invention — so
      // the assertion for that shape is that it loaded and is callable, which
      // is the part that actually breaks.
      const router = mod.default ?? mod.router;
      if (!router) {
        const factories = Object.entries(mod).filter(([, v]) => typeof v === 'function');
        expect(factories.length,
          'a route file must export a router as default, or a factory that builds one').toBeGreaterThan(0);
        return;
      }

      expect(typeof router).toBe('function');

      // Mounting catches what importing does not: a router that is an object
      // rather than middleware, or one whose stack Express refuses.
      const app = express();
      expect(() => app.use(router)).not.toThrow();

      // And it declares at least one handler. A router that mounts cleanly and
      // routes nothing is a file whose routes silently stopped existing.
      expect(router.stack?.length ?? 0).toBeGreaterThan(0);
    },
  );
});
