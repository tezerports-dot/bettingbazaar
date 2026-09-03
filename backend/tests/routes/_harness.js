// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The route harness — a real Express app, real routers, real database.
 *
 * ── Why these tests are not unit tests ──────────────────────────────────────
 * The defects this platform kept producing at the route layer were not logic
 * errors. They were handlers that could not run at all: `.save()` called on a
 * plain object the repository returned, `.select()` chained onto a promise, a
 * create that passed no id to a table whose primary key is one. Every one of
 * those is invisible to a unit test that mocks the data layer, because the mock
 * has whatever method the handler reaches for.
 *
 * So nothing here is mocked below the HTTP boundary. The router is the real
 * one, the middleware chain is the real one, the token is really minted and
 * really verified, and the database is really PostgreSQL. A handler that would
 * throw in production throws here.
 *
 * ── What is deliberately NOT covered ────────────────────────────────────────
 * Rate limiting, CSRF and the WAF filter are mounted by `server.js`, not by the
 * routers, so a route test says nothing about them. They have their own suites.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { signToken } from '../../domains/identity/paseto.util.js';
import { createUser, updateUser, setRoles } from '#db/repositories/users.js';

/**
 * Mount one router on a bare app, with only the middleware the router itself
 * relies on: a JSON body parser and cookies.
 *
 * `mergeParams` is off and no prefix is applied, so paths in a test are the
 * paths the router declares — a test that passes here is asserting the route,
 * not a mount point that could differ in server.js.
 */
export function mountRouter(router, { prefix = '' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  if (prefix) app.use(prefix, router); else app.use(router);
  // The error shape the app uses. Without this Express 5 renders HTML for a
  // thrown handler and a test asserting `body.success` reads `undefined` — the
  // failure looks like a wrong field rather than a 500.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, message: err.message });
  });
  return app;
}

/**
 * Create a real account and mint a token it can actually authenticate with.
 *
 * The token is signed by the same function the login handler uses and verified
 * by the same middleware, so an auth change that breaks the routes breaks these
 * tests too. A hand-written `req.user` would keep passing.
 */
export async function actor({
  userId, roles = [], isAdmin = false, isSubAdmin = false,
  isQueueManager = false, kycStatus = 'APPROVED', permissions = null,
} = {}) {
  const id = userId || `rt-${Math.random().toString(36).slice(2, 10)}`;
  const mobile = `9${String(Date.now()).slice(-9)}`.slice(0, 10);

  await createUser({ userId: id, username: id, mobile, kycStatus });
  const patch = { isAdmin, isSubAdmin, isQueueManager };
  if (permissions) patch.subAdminPermissions = permissions;
  await updateUser(id, patch);
  if (roles.length) await setRoles(id, roles);

  const token = signToken({ userId: id });
  return { userId: id, mobile, token, auth: `Bearer ${token}` };
}

/** `request(app)` with the Authorization header already attached. */
export function as(app, who) {
  const agent = request(app);
  const wrap = (method) => (url) => agent[method](url).set('Authorization', who.auth);
  return {
    get: wrap('get'), post: wrap('post'), put: wrap('put'),
    patch: wrap('patch'), delete: wrap('delete'),
  };
}

export { request };
