// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Pure, dependency-free CSV serialization (no data layer, no side effects) so it
// can be imported by BOTH reporting.service.js and the CPU worker thread
// (services/cpuWorker.js) without dragging the DB layer into the worker. Item 5:
// serializing a large regulatory export is genuinely CPU-bound string work; the
// worker pool offloads it off the single event loop for big exports.

/**
 * A text cell a spreadsheet would run as a formula (`=`, `+`, `@`, a tab or
 * carriage return, or `-` not starting a number) gets a leading `'`, so a
 * player who names themselves `=HYPERLINK(…)` exports as text. Numbers are
 * left alone, negative ones included.
 */
const FORMULA_START = /^(?:[=+@\t\r]|-(?![\d.]))/;

/** toCsv — minimal CSV serialization with RFC-4180 quoting. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => {
    let s = String(v ?? '');
    if (typeof v === 'string' && FORMULA_START.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

/**
 * parseCsv — the reverse of `toCsv`: RFC-4180 fields (quotes, doubled quotes,
 * commas and line breaks inside quotes), `\n` or `\r\n` rows. Returns an array
 * of rows, each an array of trimmed strings; blank rows are dropped. A leading
 * `'` that `toCsv` adds against formulas is removed, so a downloaded file
 * uploads back unchanged.
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = []; let field = ''; let quoted = false;
  const endField = () => { const t = field.trim(); row.push(t.startsWith("'") ? t.slice(1) : t); field = ''; };
  const endRow = () => { endField(); if (row.some((c) => c !== '')) rows.push(row); row = []; };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.trim() === '') { field = ''; quoted = true; }
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}
