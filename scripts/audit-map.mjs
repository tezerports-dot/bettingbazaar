// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * audit-map.mjs — keeps the security audit map honest.
 *
 * ── The problem this exists to solve ────────────────────────────────────────
 * A security audit written as prose is accurate on the day it is written and
 * wrong a week later, silently. Somebody adds a route with no auth, and the
 * document still says "40 unauthenticated routes, all reviewed". The reader
 * cannot tell the difference between "examined and clear" and "written before
 * this code existed", so the whole document stops being evidence.
 *
 * `CLAUDE.md` §28 names the failure directly: a gate whose failure mode is "the
 * author forgot to update me" reports the author. So the numbers in
 * `docs/audit/SECURITY_AUDIT_MAP.md` are not typed by hand. They are DERIVED
 * from the codebase, written into a delimited block, and `--check` fails the
 * build when the block no longer matches what the code says.
 *
 * What that does and does not buy:
 *
 *   IT DOES catch a new unauthenticated route, a new admin route with no
 *   permission key, a new SQL interpolation, a new `dangerouslySetInnerHTML`,
 *   and a route count that has moved. Any of those makes CI red until somebody
 *   re-runs this and looks at what changed.
 *
 *   IT DOES NOT decide whether the change is SAFE. A new public route may be a
 *   health probe or an account takeover; only a person reading it can say. This
 *   forces the reading to happen — it does not replace it.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   npm run audit:map          rewrite the generated block
 *   npm run audit:map -- --check   fail if the block is stale (this is the gate)
 *   npm run audit:map -- --json    print the raw facts, for a human digging in
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location — never an absolute path to somebody's
// checkout. `verify-ui-coverage.mjs` shipped with one of those once and could
// not run anywhere but the author's machine (CLAUDE.md §28).
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAP = join(ROOT, 'docs/audit/SECURITY_AUDIT_MAP.md');
const BEGIN = '<!-- BEGIN GENERATED: npm run audit:map -->';
const END = '<!-- END GENERATED -->';

const walk = (dir, ext, skip = []) => {
  const out = [];
  (function rec(d) {
    let entries; try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.git' || skip.includes(e)) continue;
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else if (ext.some((x) => e.endsWith(x))) out.push(p);
    }
  })(dir);
  return out;
};
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// ── Route inventory ─────────────────────────────────────────────────────────
// Parsed from `router.<verb>(path, ...middleware, handler)`. The middleware
// names are what the authorisation questions below are asked of.
function routes() {
  const files = walk(join(ROOT, 'backend'), ['.js'], ['tests']);
  const out = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2\s*,?([^\n]*)/g)) {
      const rest = src.slice(m.index + m[0].length - m[4].length);
      const chunk = (m[4] + rest.slice(0, 400)).split(/async\s*\(|\(req\s*,/)[0];
      out.push({
        file: rel(f),
        line: src.slice(0, m.index).split('\n').length,
        method: m[1].toUpperCase(),
        path: m[3],
        mw: [...new Set([...chunk.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\(|,|\))/g)].map((x) => x[1]))],
      });
    }
  }
  return out;
}

const AUTH = new Set(['authenticate', 'merchantAuth', 'isAdmin', 'isAdminOrSubAdmin',
  'isAdminOrSubAdminOrQueueManager', 'hasPermission', 'hasAllPermissions', 'hasAnyPermission',
  'canManageSupport', 'orderAccessGuard', 'paymentActorAuth', 'checkResourcePermission',
  'requireChannelMembership', 'optionalAuth']);

/**
 * A VARIANT of a known guard counts as that guard.
 *
 * `authenticateForEnrolment` is `authenticate` with one flag — staff who owe a
 * second factor may pass, because the routes behind it are the only way to stop
 * owing one. It authenticates in every other respect, and the hand-written set
 * above did not know the name, so the two 2FA enrolment routes were reported as
 * "reachable with no auth middleware" the moment they started using it.
 *
 * A false entry on THAT list is worse than a missing one. The list exists to be
 * read by a person, and §0 of this document is about a map that stops being
 * evidence and becomes decoration: two routes that are plainly authenticated
 * sitting under "no auth middleware" teaches the reader to skim it.
 *
 * So the check is a prefix, not a lookup — the same reason `check:ui-coverage`
 * derives its mount prefixes from server.js instead of keeping a table: a gate
 * whose failure mode is "the author forgot to update me" reports the author
 * rather than the code (CLAUDE.md §28).
 */
const isAuthGuard = (name) => AUTH.has(name) || /^authenticate[A-Z]/.test(name);
const PERM = /^(hasPermission|hasAnyPermission|hasAllPermissions|checkResourcePermission)$/;

// ── SQL: interpolation into statement text ──────────────────────────────────
// A parameterised query is safe by construction. An interpolated one is safe
// only if what it interpolates cannot come from a request — that is a reading,
// not a count, so this reports the count and the map records the reading.
function sql() {
  const files = [...walk(join(ROOT, 'database'), ['.js'], ['tests']),
                 ...walk(join(ROOT, 'backend'), ['.js'], ['tests'])];
  let interpolating = 0, paramsOnly = 0;
  const sites = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/pgQuery\(\s*\n?\s*`/g)) {
      const i = src.indexOf('`', m.index + m[0].length - 1);
      let j = i + 1;
      for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '`') break; }
      const body = src.slice(i + 1, j);
      const hits = [...body.matchAll(/\$\{([^}]*)\}/g)];
      if (!hits.length) { paramsOnly++; continue; }
      interpolating++;
      sites.push({ file: rel(f), line: src.slice(0, m.index).split('\n').length });
    }
  }
  return { interpolating, paramsOnly, total: interpolating + paramsOnly, sites };
}

// ── Panels: the client-side injection sinks ─────────────────────────────────
function panels() {
  const out = {};
  for (const p of ['user-panel', 'admin-panel', 'merchant-panel']) {
    const files = walk(join(ROOT, p, 'src'), ['.ts', '.tsx']);
    let dangerous = 0, innerHtml = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      dangerous += (src.match(/dangerouslySetInnerHTML/g) || []).length;
      innerHtml += (src.match(/\.innerHTML\s*=/g) || []).length;
    }
    out[p] = { files: files.length, dangerouslySetInnerHTML: dangerous, innerHTML: innerHtml };
  }
  return out;
}

function facts() {
  const all = routes();
  const unauth = all.filter((r) => !r.mw.some((m) => isAuthGuard(m)));
  const subAdminNoKey = all.filter((r) => r.mw.includes('isAdminOrSubAdmin') && !r.mw.some((m) => PERM.test(m)));
  return {
    routes: {
      total: all.length,
      unauthenticated: unauth.length,
      // File, NOT file:line. A line number moves whenever anything above it
      // moves — adding an import churned five entries once — so including it
      // makes the gate fire on edits that changed no route at all. A gate that
      // cries wolf trains its reader to regenerate without looking, which is
      // precisely the failure it exists to prevent. It fires when a route
      // APPEARS, VANISHES or CHANGES SHAPE, and not otherwise.
      unauthenticatedList: unauth.map((r) => `${r.method} ${r.path}  (${r.file})`).sort(),
      subAdminNoPermissionKey: subAdminNoKey.length,
      subAdminNoPermissionKeyWrites: subAdminNoKey.filter((r) => r.method !== 'GET')
        .map((r) => `${r.method} ${r.path}  (${r.file})`).sort(),
      withPermissionKey: all.filter((r) => r.mw.some((m) => PERM.test(m))).length,
    },
    sql: (({ sites, ...rest }) => rest)(sql()),
    panels: panels(),
  };
}

function block(f) {
  const L = [];
  L.push(BEGIN);
  L.push('');
  L.push('> Everything between these markers is DERIVED from the codebase by');
  L.push('> `scripts/audit-map.mjs`. Do not hand-edit it — `npm run audit:map -- --check`');
  L.push('> runs in CI and fails when it drifts, which is the point: a number here');
  L.push('> that nobody re-derived is a number that stopped being evidence.');
  L.push('');
  L.push('### Routes');
  L.push('');
  L.push('| Measure | Count |');
  L.push('|---|---|');
  L.push(`| Route declarations in \`backend/**\` | ${f.routes.total} |`);
  L.push(`| Reachable with **no auth middleware** | ${f.routes.unauthenticated} |`);
  L.push(`| Gated \`isAdminOrSubAdmin\` with **no permission key** | ${f.routes.subAdminNoPermissionKey} |`);
  L.push(`| — of those, **writes** (non-GET) | ${f.routes.subAdminNoPermissionKeyWrites.length} |`);
  L.push(`| Carrying an explicit permission key | ${f.routes.withPermissionKey} |`);
  L.push('');
  L.push('A count moving is not by itself a defect — it is a prompt to read the');
  L.push('new route and decide. Each of the three questions is defined in §2.');
  L.push('');
  L.push('<details><summary>Every route with no auth middleware (read each one before dismissing it)</summary>');
  L.push('');
  for (const r of f.routes.unauthenticatedList) L.push(`- \`${r}\``);
  L.push('');
  L.push('</details>');
  L.push('');
  L.push('<details><summary>Writes any sub-admin can make without holding a permission key</summary>');
  L.push('');
  if (!f.routes.subAdminNoPermissionKeyWrites.length) L.push('- _none_');
  for (const r of f.routes.subAdminNoPermissionKeyWrites) L.push(`- \`${r}\``);
  L.push('');
  L.push('</details>');
  L.push('');
  L.push('### SQL');
  L.push('');
  L.push('| Measure | Count |');
  L.push('|---|---|');
  L.push(`| \`pgQuery\` call sites | ${f.sql.total} |`);
  L.push(`| Parameters only (safe by construction) | ${f.sql.paramsOnly} |`);
  L.push(`| Interpolating into statement text (each needs a reading) | ${f.sql.interpolating} |`);
  L.push('');
  L.push('### Panel injection sinks');
  L.push('');
  L.push('| Panel | .ts/.tsx files | `dangerouslySetInnerHTML` | `.innerHTML =` |');
  L.push('|---|---|---|---|');
  for (const [p, v] of Object.entries(f.panels)) {
    L.push(`| \`${p}\` | ${v.files} | ${v.dangerouslySetInnerHTML} | ${v.innerHTML} |`);
  }
  L.push('');
  L.push(END);
  return L.join('\n');
}

const argv = process.argv.slice(2);
const f = facts();

if (argv.includes('--json')) {
  console.log(JSON.stringify(f, null, 2));
  process.exit(0);
}

let doc;
try { doc = readFileSync(MAP, 'utf8'); }
catch { console.error(`Missing ${rel(MAP)} — the map is the thing this maintains.`); process.exit(1); }

const i = doc.indexOf(BEGIN), j = doc.indexOf(END);
if (i < 0 || j < 0) {
  console.error(`${rel(MAP)} has no generated block. Add the BEGIN/END markers back.`);
  process.exit(1);
}
const current = doc.slice(i, j + END.length);
const fresh = block(f);

if (argv.includes('--check')) {
  if (current === fresh) {
    console.log(`✅ ${rel(MAP)} matches the codebase.`);
    console.log(`   ${f.routes.total} routes · ${f.routes.unauthenticated} unauthenticated · ` +
                `${f.routes.subAdminNoPermissionKey} sub-admin routes with no permission key · ` +
                `${f.sql.interpolating}/${f.sql.total} SQL sites interpolating`);
    process.exit(0);
  }
  console.error(`❌ ${rel(MAP)} is STALE — the code has moved and the map has not.\n`);
  console.error('Run `npm run audit:map`, then READ the diff. A number that changed');
  console.error('means a route, a query or a render sink appeared or vanished, and');
  console.error('somebody has to decide whether that is safe. This gate cannot.\n');
  const a = current.split('\n'), b = fresh.split('\n');
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    if (a[k] !== b[k]) {
      if (a[k] !== undefined) console.error(`  - ${a[k]}`);
      if (b[k] !== undefined) console.error(`  + ${b[k]}`);
    }
  }
  process.exit(1);
}

writeFileSync(MAP, doc.slice(0, i) + fresh + doc.slice(j + END.length));
console.log(`✅ Rewrote the generated block in ${rel(MAP)}.`);
console.log(`   ${f.routes.total} routes · ${f.routes.unauthenticated} unauthenticated · ` +
            `${f.routes.subAdminNoPermissionKey} sub-admin routes with no permission key · ` +
            `${f.sql.interpolating}/${f.sql.total} SQL sites interpolating`);
