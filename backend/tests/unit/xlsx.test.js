// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// The workbook writer every download goes through (`xlsx.util.js`): a valid
// zip a reader opens, labelled tables, numbers as numbers, times in IST, and
// a would-be formula kept as text.
import { describe, it, expect } from 'vitest';
import { toXlsx, columnsOf, labelOf, istText, oneTable } from '../../domains/reporting/xlsx.util.js';
import { readXlsx } from '../_xlsx.js';

describe('toXlsx', () => {
  it('writes each table under its heading, numbers as numbers, the transaction ID where it was put', () => {
    const book = readXlsx(toXlsx({ sheets: [{ name: 'Ledger', title: 'Business ledger', subtitle: 'Range', tables: [
      { heading: 'Buys', accent: 'green', columns: [{ key: 'at', label: 'Time', type: 'time' }, { key: 'tokens', label: 'Tokens', type: 'money' }, { key: 'id', label: 'Transaction ID' }],
        rows: [{ at: '2026-10-21T08:00:00Z', tokens: 1234.5, id: 'DEP_1' }], totals: { tokens: 1234.5 } },
      { heading: 'Sells', accent: 'red', columns: [{ key: 'id', label: 'Transaction ID' }], rows: [] },
    ] }] }));
    const rows = book.Ledger;
    expect(rows[0][0]).toBe('Business ledger');
    const buys = rows.findIndex((r) => r[0] === 'Buys');
    expect(rows[buys + 1]).toEqual(['Time', 'Tokens', 'Transaction ID']);
    expect(rows[buys + 2]).toEqual(['2026-10-21 13:30:00 IST', 1234.5, 'DEP_1']);
    expect(rows[buys + 3]).toEqual(['Total', 1234.5, '']);
    expect(rows.some((r) => r[0] === 'Nothing in this range.')).toBe(true);
  });

  it('keeps text that looks like a formula as text, never a formula', () => {
    const buf = toXlsx(oneTable({ name: 'Players', columns: [{ key: 'name', label: 'Name' }], rows: [{ name: '=HYPERLINK("http://x")' }] }));
    expect(readXlsx(buf).Players.flat()).toContain('=HYPERLINK("http://x")');
    expect(buf.includes(Buffer.from('<f>'))).toBe(false);
  });

  it('gives Excel sheet names it accepts, unique and short', () => {
    const book = readXlsx(toXlsx({ sheets: [
      { name: 'a/b', tables: [] }, { name: 'A/B', tables: [] }, { name: 'x'.repeat(40), tables: [] },
    ] }));
    const names = Object.keys(book);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
    expect(names.every((n) => n.length <= 31 && !/[[\]:*?/\\]/.test(n))).toBe(true);
  });

  it('types columns from their values and names them from their keys', () => {
    const cols = columnsOf([{ user_id: 'u', at: '2026-10-21T08:00:00Z', count: 3, rate: 1.5, amount: 2 }], { money: ['amount'] });
    expect(cols.map((c) => c.type)).toEqual(['text', 'time', 'int', 'money', 'money']);
    expect(labelOf('vipBalance')).toBe('Vip balance');
    expect(istText('2026-10-21T08:00:00Z')).toBe('2026-10-21 13:30:00 IST');
  });
});
