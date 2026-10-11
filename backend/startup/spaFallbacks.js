// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// spaFallbacks.js — which index.html answers a page path the static mounts did
// not. Mounted last, after every API route and static directory.
//
// Each panel's pattern is `/<panel>{/*splat}` so it covers the panel's ROOT
// too. Under Express 5 (path-to-regexp 8) `/admin/*splat` needs at least one
// character after the slash: `/admin` and `/admin/` fell through to the player
// app, and the admin panel (a HashRouter, so `/admin/` is its only page) could
// not be opened at all.
import fs from 'fs';
import path from 'path';

/** @param {string} root the directory holding dist/, admin-panel/ and merchant-panel/ */
export function mountSpaFallbacks(app, root) {
  const panel = (indexPath, missing) => (req, res, next) => {
    if (req.path.startsWith('/api') || path.extname(req.path)) return next();
    fs.existsSync(indexPath) ? res.sendFile(indexPath) : missing(res);
  };
  app.get('/admin{/*splat}', panel(path.join(root, 'admin-panel/dist/index.html'),
    (res) => res.status(503).send('<h1>Admin Panel Not Built</h1>')));
  app.get('/merchant{/*splat}', panel(path.join(root, 'merchant-panel/dist/index.html'),
    (res) => res.status(503).send('<h1>Merchant Panel Not Built</h1>')));
  app.get('/{*splat}', panel(path.join(root, 'dist/index.html'),
    (res) => res.status(200).json({ success: true, message: 'API running.' })));
}
