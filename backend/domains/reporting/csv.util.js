// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Pure, dependency-free CSV serialization (no data layer, no side effects) so it
// can be imported by BOTH reporting.service.js and the CPU worker thread
// (services/cpuWorker.js) without dragging the DB layer into the worker. Item 5:
// serializing a large regulatory export is genuinely CPU-bound string work; the
// worker pool offloads it off the single event loop for big exports.

/** toCsv — minimal CSV serialization with RFC-4180 quoting. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}
