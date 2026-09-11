#!/usr/bin/env node
/**
 * verify-error-responses.mjs — an unexpected failure may not describe itself
 * to the caller, and may not go unlogged.
 *
 * Closes F-008 and F-013 together, as ONE gate, deliberately.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * A failure a handler answers is one of exactly two things:
 *
 *   • a refusal somebody WROTE for the caller to read — "That code is not
 *     valid", "This UTR was already used", `USDT_RATE_UNSET`. Its wording is
 *     the feature, and §25 and §27 both require it to name its own reason.
 *     It carries a `status`. `callerError()` is for these.
 *   • an unexpected fault — a Postgres constraint name, an `fs` path, a fetch
 *     to an internal host. It is nobody's answer. It gets logged in full and
 *     the caller is told nothing. `serverError()` is for these.
 *
 * `respondError()` is for a `catch` that holds either and cannot know which.
 *
 * ── What was actually happening, in two shapes ─────────────────────────────
 * F-008 was the plain form: `res.status(500).json({ message: err.message })`.
 * Four of its sites needed no authentication at all, and NONE of them logged —
 * the failure reached the one party who must not see it and never reached the
 * one who could act on it.
 *
 * F-013 was the same leak written as a fallback:
 *
 *     res.status(err.status || 500).json({ success: false, message: err.message })
 *
 * 26 sites. Every one had ALREADY been found by F-008's sweep and sorted into
 * "deliberate refusal, keep the wording" — because that expression IS a correct
 * refusal, exactly half the time. When `.status` is unset it is the leak, on
 * `POST /payment/deposit/create` and `POST /payment/withdrawal/create` among
 * others, neither of which logged.
 *
 * ── Why ONE gate ───────────────────────────────────────────────────────────
 * This is the actual lesson and the reason the two shapes are checked here
 * together rather than in two scripts. A gate written for the plain form alone
 * goes green over all 26 of the fallback form and reports the class CLOSED.
 * That is worse than no gate: §29 — absence of a failing check is not evidence
 * of correctness when no check covers the thing being claimed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { blankComments } from './lib/privacyLists.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p);

/**
 * The one file allowed to name these shapes, because it is the thing that
 * replaces them — the same self-exclusion `verify-no-mongo.mjs` uses, and for
 * the same reason. Excluded BY PATH; nothing else is exempt.
 */
const OWNER = 'backend/shared/httpError.js';

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (/\.m?js$/.test(name) && !/\.test\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

const failures = [];
const fail = (where, why) => failures.push(`${where}\n      ${why}`);

/**
 * `res.status(<expr>).json(` where <expr> can answer 5xx, paired with the
 * error's own message somewhere in the payload.
 *
 * Comments are blanked first. An apostrophe in `// the caller's message` is an
 * opening quote to anything counting brackets — that is trap §24.6, which had
 * a producer check silently measuring zero things and reading exactly like a
 * pass.
 */
const STATUS_CALL = /res\s*\.status\(\s*([^)]*)\)\s*\.json\(/g;

/** A literal 5xx, or the `err.status || 5xx` fallback that yields one. */
function answersServerError(statusExpr) {
  if (/^\s*5\d\d\s*$/.test(statusExpr)) return 'a literal 5xx';
  if (/\.(status|statusCode)\s*\|\|\s*5\d\d/.test(statusExpr)) {
    return 'a `|| 5xx` fallback, which is the 5xx branch whenever the thrower set no status';
  }
  return null;
}

for (const file of jsFiles(join(ROOT, 'backend'))) {
  const where = rel(file);
  if (where === OWNER) continue;
  const src = blankComments(readFileSync(file, 'utf8'));

  for (const m of src.matchAll(STATUS_CALL)) {
    const kind = answersServerError(m[1]);
    if (!kind) continue;

    // Balance from the `(` of `.json(` rather than matching to the next `}`:
    // these payloads run to several lines and carry their own parentheses.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
    }
    const body = src.slice(m.index + m[0].length, i - 1);

    // The error's own text, reached however: `err.message`, `e.stack`,
    // `error.message || 'fallback'`, `String(err)`.
    const leak = body.match(/\b(?:err|error|e)\s*\??\.\s*(message|stack)\b/)
      || body.match(/String\(\s*(?:err|error|e)\s*\)/);
    if (!leak) continue;

    // The discriminated form is correct and stays: the raw message is reachable
    // only on the branch where somebody set a status.
    if (/\.(status|statusCode)\s*\?[^:]*:/.test(body)) continue;

    const line = src.slice(0, m.index).split('\n').length;
    fail(`${where}:${line}`,
      `answers with ${kind} and hands the caller the error's own text.\n`
      + '      From a Postgres driver that is a constraint name and sometimes a\n'
      + '      statement fragment; from `fs` a path; from a fetch an internal host.\n'
      + '      Use respondError(res, err, \'<route>\') — it keeps a deliberate refusal\n'
      + '      exactly as it is, and logs + generalises everything else.');
  }
}

/**
 * The second half, and the one that is easy to lose: `serverError()` must
 * actually log. A future edit that keeps the signature and drops the
 * `console.error` would leave every converted site silent while every check
 * here still passes — the failure reaching nobody, which is the half of F-008
 * that was worse than the disclosure.
 */
{
  const src = blankComments(readFileSync(join(ROOT, OWNER), 'utf8'));
  const body = src.slice(src.indexOf('export function serverError'),
                         src.indexOf('export function callerError'));
  if (!/console\.error/.test(body)) {
    fail(OWNER, 'serverError() no longer logs. Every site converted to it then answers'
      + '\n      the caller with nothing AND tells the operator nothing — the failure'
      + '\n      reaches neither party. That is worse than the leak it replaced.');
  }
  if (!/export function respondError/.test(src)) {
    fail(OWNER, 'respondError() is gone. The F-013 sites have nowhere to route a catch'
      + '\n      that holds a deliberate refusal and an unexpected fault at once.');
  }
}

if (failures.length) {
  console.error(`\nERROR RESPONSES: ${failures.length} violation(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error('An unexpected failure is logged in full and answered with nothing.\n'
    + 'A deliberate refusal keeps its wording. The two are different functions so\n'
    + 'that a handler has to say which it is holding.  — CLAUDE.md, F-008/F-013\n');
  process.exit(1);
}
console.log('check:error-responses — no 5xx hands the caller its own error text, and serverError still logs.');
