// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routeCoverage.js — which routes did any test actually CALL? (a test facility)
 *
 * Owner, 2026-10-01: measure the coverage gaps "instead of guessing". A route
 * test proves a handler works; it never proves the other 300 routes were
 * reached by anything (§28). This records, during every test tier, each route
 * the server dispatched and what it answered, and `npm run report:routes`
 * compares that with the full inventory.
 *
 * ── How a route is identified ──────────────────────────────────────────────
 * By the FILE AND LINE of its `router.<verb>(...)` call, captured when it is
 * registered. A route test mounts a router on its own at "/" and the real
 * server mounts it under /api/admin — a path would differ between the two, the
 * place in the source does not. The inventory (written at boot by the real
 * server) carries the full mounted path for the report to print.
 *
 * ── Why it patches the router ──────────────────────────────────────────────
 * Express 5 keeps no mount path on a layer, and by the time a response
 * finishes, an error passed to `next()` has already unwound `req.baseUrl` — so
 * a REFUSED request (the paths most worth counting) could not be attributed
 * afterwards. The route is therefore noted at dispatch, when it is known.
 *
 * OFF unless `BB_ROUTE_COVERAGE=<file>` is set, and refused in production: it
 * writes every route a caller reaches to a local file. Query strings are never
 * written (the SSE streams carry a token in one).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const FILE = process.env.BB_ROUTE_COVERAGE || '';
export const routeCoverageEnabled = Boolean(FILE);

if (routeCoverageEnabled && process.env.NODE_ENV === 'production') {
  throw new Error('BB_ROUTE_COVERAGE is a test facility and is refused in production.');
}

const require = createRequire(import.meta.url);
const ROOT_MARK = '/backend/';

/** The first stack frame in this repository's backend that is not the router. */
function callSite() {
  const lines = String(new Error().stack).split('\n').slice(2);
  for (const l of lines) {
    const m = l.match(/(?:file:\/\/)?([^\s()]+\/backend\/[^\s():]+):(\d+):\d+/);
    if (m && !m[1].includes('/node_modules/') && !m[1].endsWith('/startup/routeCoverage.js')) {
      return `backend/${m[1].split(ROOT_MARK).pop()}:${m[2]}`;
    }
  }
  return null;
}

const Router = require('router');
const Route = require('router/lib/route');

// Once per process: a test runner evaluates this module again for every test
// file, and wrapping the prototype each time would stack the wrappers.
if (routeCoverageEnabled && !Router.prototype.__bbCoveragePatched) {
  Router.prototype.__bbCoveragePatched = true;

  // ── Registration: give every route an id, and remember every mount ──────
  const originalRoute = Router.prototype.route;
  Router.prototype.route = function route(path) {
    const r = originalRoute.call(this, path);
    r.__bbId = callSite();
    (this.__bbRoutes ??= []).push(r);
    return r;
  };
  const originalUse = Router.prototype.use;
  Router.prototype.use = function use(first, ...rest) {
    const path = typeof first === 'string' ? first : '/';
    const fns = typeof first === 'string' ? rest : [first, ...rest];
    for (const fn of fns.flat()) {
      if (fn && typeof fn === 'function' && (fn.__bbRoutes || fn.stack)) (this.__bbMounts ??= []).push({ path, router: fn });
    }
    return originalUse.call(this, first, ...rest);
  };

  // ── Dispatch: record the route a request reached, and what it answered ──
  const originalDispatch = Route.prototype.dispatch;
  Route.prototype.dispatch = function dispatch(req, res, done) {
    if (!req.__bbRoute && this.__bbId) {
      req.__bbRoute = this.__bbId;
      const id = this.__bbId;
      const method = req.method;
      res.on('finish', () => {
        try {
          appendFileSync(FILE, `${JSON.stringify({ k: 'hit', id, m: method, s: res.statusCode })}\n`);
        } catch { /* coverage is best-effort; never fail a request over it */ }
      });
    }
    return originalDispatch.call(this, req, res, done);
  };
}

const join = (a, b) => (`${a}/${b}`).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

/**
 * Write every route the app serves, with its full mounted path, beside the hit
 * file. Called once by the server after every router is mounted.
 */
export function writeRouteInventory(app) {
  if (!routeCoverageEnabled) return;
  const root = app.router ?? app._router;
  const out = [];
  const seen = new Set();
  (function walk(router, prefix) {
    if (!router || seen.has(router)) return;
    seen.add(router);
    for (const r of router.__bbRoutes ?? []) {
      for (const m of Object.keys(r.methods ?? {})) {
        if (m === '_all') continue;
        out.push({ id: r.__bbId, m: m.toUpperCase(), path: join(prefix, r.path) });
      }
    }
    for (const { path, router: child } of router.__bbMounts ?? []) walk(child, join(prefix, path));
  })(root, '/');
  writeFileSync(`${FILE}.inventory.json`, JSON.stringify(out, null, 1));
}
