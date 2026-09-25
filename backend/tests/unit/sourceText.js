// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// sourceText.js — the ONE comment stripper for suites that read source text.
//
// (Written in line comments throughout, deliberately: a block comment
// explaining a block-comment stripper has to contain the delimiters it is
// describing, and the first draft of this file closed itself early on one.)
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Eight suites assert things about a file's TEXT rather than its behaviour.
// §22 is clear that this is a weak claim; where it is made it must at least be
// made correctly. Each of them carried its own copy of the same two steps, in
// two variants, and §5 says what happens next.
//
// The copies stripped BLOCK comments FIRST, with an unanchored pattern. That is
// wrong, and it was silent for as long as nobody added a comment:
//
//   `server.js` holds SIX block-comment openers and exactly ONE closer. Five of
//   the six openers are prose inside a `//` comment, or text inside a string
//   literal such as '/admin/*splat'. So the greedy match paired whichever
//   opener it met first with the file's one real closer and deleted everything
//   between them.
//
// MEASURED: adding one `//` block above `app.use(compression(...))` moved which
// opener came first, the strip ate a span of three hundred lines, and
// `playerFormAuth.test.js` reported `app.use('/api/v1/auth', playerAuthRoutes)`
// MISSING — a mount plainly present on line 532. A failing test naming a defect
// that did not exist, caused by an unrelated comment. §24.6's shape exactly
// ("blank comments before scanning"), which is already written down.
//
// ── THE TWO OBVIOUS FIXES ARE BOTH WRONG, AND BOTH WERE MEASURED ────────────
//
//   * Swapping the steps — drop the `//` lines first, then blocks — breaks
//     `routes.js` instead. Removing `*`-prefixed lines destroys the CLOSERS of
//     real JSDoc blocks, so the surviving openers pair with a later closer and
//     take real code with them: `export const LOGIN_DOOR` disappeared.
//   * Stripping every trailing `//…` as well eats the inside of any regex
//     literal holding two slashes, of which this codebase has many because it
//     matches paths.
//
// What works on both files is ANCHORING THE OPENER to the start of a line —
// which is where every real block comment in this repository begins, and where
// an opener inside a string literal or inside a line comment never is.

/**
 * Strip comments from JS source.
 *
 * 1. block comments whose opener starts a line, closer to closer;
 * 2. whole-line `//` comments and `*` continuation lines.
 *
 * A trailing `// …` on a line that also holds code is deliberately LEFT — see
 * `codeOnly()` for the callers that cannot tolerate that, and why they are the
 * ones that had to change.
 */
export function stripComments(text) {
  return String(text)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}

/**
 * `stripComments`, plus what remains of a TRAILING line comment — for the
 * suites that assert a word is ABSENT and would otherwise read it out of a note
 * saying why it is absent.
 *
 * The trailing strip is deliberately conservative: it fires only where the `//`
 * is preceded by whitespace or the line's start AND every quote before it on
 * that line is closed. A `//` inside a string survives; so does the inside of a
 * regex literal, because a regex that matches a path writes its slashes escaped
 * (`\/\/`), which is not two bare slashes. `https://` is preceded by a colon.
 */
export function codeOnly(text) {
  return stripComments(text).split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length - 1; i += 1) {
      const c = line[i];
      if (c === '\\') { i += 1; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))) {
        return line.slice(0, i).replace(/\s+$/, '');
      }
    }
    return line;
  }).join('\n');
}
