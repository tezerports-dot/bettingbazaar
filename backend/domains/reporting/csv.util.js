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
