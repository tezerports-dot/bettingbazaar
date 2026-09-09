// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * privacyLists.mjs — the two things both privacy gates have to do.
 *
 * There are two projections on this platform pointing in opposite directions —
 * `merchantOrderView.js` (what a merchant may learn about a player) and
 * `playerOrderView.js` (what a player may learn about the merchant serving
 * them) — and a gate for each. Both gates have to read a frozen list out of a
 * module's source, and both have to find the argument of a call spanning any
 * number of lines.
 *
 * Written once here for the reason §1 gives: the same logic in two files drifts,
 * and it drifts silently. A responder-scanner that handled multi-line calls in
 * one gate and single lines in the other would report a clean merchant surface
 * while a leak sat three lines below a `res.json(`.
 */

/**
 * Replace every comment in `src` with spaces, keeping newlines — so the result
 * is the same length, on the same lines, and every index and line number a
 * scan reports still points at the original file.
 *
 * Every scan below has to run on this first. An apostrophe in English prose is
 * an opening quote to a bracket counter: `// one owner of the player's shape`
 * swallowed the rest of a return literal, and the producer check reported no
 * `order` key in a function that plainly returns one. That is trap 11 in a new
 * costume — a gate reading text it was not built to parse — and it fails SILENT,
 * which is the direction that matters.
 */
export function blankComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i += 1) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c; i += 1;
      while (i < src.length) {
        out += src[i];
        if (src[i] === '\\') { i += 1; if (i < src.length) out += src[i]; i += 1; continue; }
        if (src[i] === c) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/**
 * Pull a frozen string array out of module source by name.
 *
 * Source, not an import, deliberately: these gates run over files that pull in
 * `#db` and a live pool at module scope. Reading the text keeps the check
 * runnable with no database, which is what lets it run first in CI.
 */
export function frozenList(src, name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * Every call of `name(` in `src`, with its argument text, the 1-based line it
 * starts on, and its character offset (so a caller can slice back to the
 * enclosing handler). The argument is extracted by counting brackets, so a payload
 * spread over twenty lines is one result and not twenty misses.
 *
 * Strings are tracked so a bracket inside one — `'}'`, or a template literal
 * holding SQL — does not close the call early.
 */
export function callsTo(src, name) {
  const out = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;
    // `emitOrderUpdate` must not match `_emitOrderUpdate` or `.emitOrderUpdate`
    // when the gate is asked for the bare name.
    const before = at === 0 ? '' : src[at - 1];
    if (/[A-Za-z0-9_$.]/.test(before)) continue;

    const end = closeOf(src, from);
    out.push({
      line: src.slice(0, at).split('\n').length,
      index: at,
      args: src.slice(from, end),
    });
  }
  return out;
}

/**
 * Every `return { … }` in `src`, with the literal's text and its 1-based line.
 *
 * A separate scan from `callsTo` because `return` is not a call: the gate that
 * follows a producer's returned `order` key looked for `return(` and matched
 * nothing at all, which is the failure mode a gate must never have. It reported
 * clean while the producer it was written to check had stopped projecting.
 */
export function returnedLiterals(src) {
  const out = [];
  for (const m of src.matchAll(/\breturn\s*\{/g)) {
    const open = m.index + m[0].length;
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      index: m.index,
      body: src.slice(open, closeOf(src, open)),
    });
  }
  return out;
}

/**
 * The index just past the bracket that closes the one opened before `from`.
 * Strings are tracked so a bracket inside one — `'}'`, or a template literal
 * holding SQL — does not close the group early.
 */
function closeOf(src, from) {
  let depth = 1;
  let quote = null;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/**
 * The top-level keys of an object literal in `text` — the payload's own keys,
 * not those of anything nested inside it.
 *
 * Nesting matters: a merchant record nested under an admin-only key is not the
 * same disclosure as the same field sitting at the top of a player's payload,
 * and a gate that could not tell them apart would have to be silenced somewhere
 * to stay green.
 */
export function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  let quote = null;
  let atKeyPosition = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth += 1; atKeyPosition = depth === 1 && c === '{'; continue; }
    if (c === '}' || c === ']' || c === ')') { depth -= 1; continue; }
    if (depth === 1 && c === ',') { atKeyPosition = true; continue; }
    if (depth !== 1 || !atKeyPosition) continue;
    if (/\s/.test(c)) continue;
    // `key: value` and the SHORTHAND `key` — `{ spec }` names `spec` just as
    // `{ spec: spec }` does, and a scan that saw only the first form reported a
    // payload as missing a key it plainly carries.
    const m = text.slice(i).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*([:,}]|$)/);
    if (m) keys.push(m[1]);
    // A shorthand key (`{ order }`) or a spread — both are named by whatever
    // follows, and neither starts a new key position until the next comma.
    atKeyPosition = false;
  }
  return keys;
}

/**
 * The top-level SPREADS of an object literal in `text` — `...order` and what
 * follows it, up to the next comma at the same depth.
 *
 * A key scan cannot see these, and a spread is exactly how a whole order
 * reached a merchant's stream: `{ ...order, server_ts: Date.now() }` names one
 * permitted key and carries thirty forbidden ones. So the gates read spreads
 * separately and require each to be a projection call by name.
 */
export function topLevelSpreads(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth += 1; continue; }
    if (c === '}' || c === ']' || c === ')') { depth -= 1; continue; }
    if (depth !== 1 || c !== '.' || text.slice(i, i + 3) !== '...') continue;
    // To the end of this element: the next comma at THIS depth, or the close.
    let j = i + 3;
    let d = 0;
    let q = null;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (q) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { d += 1; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { if (d === 0) break; d -= 1; continue; }
      if (ch === ',' && d === 0) break;
    }
    out.push(text.slice(i + 3, j).trim());
    i = j;
  }
  return out;
}
