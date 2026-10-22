// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every table a panel downloads, as an Excel workbook (owner, 2026-10-21):
 * one sheet per kind of record, each table under its own coloured heading
 * with labelled columns, numbers as numbers, times in IST and an optional
 * totals row. Pure and dependency-free: the parts are written as XML and
 * zipped with `node:zlib` (deflate + CRC-32), so nothing new enters the
 * lockfile (§17.1).
 *
 * A cell is a number or an inline string, never a formula: an xlsx cell runs
 * only what is inside `<f>`, which this never writes, so a player who names
 * themselves `=HYPERLINK(…)` downloads as that text (the guard `toCsv` needs
 * a leading `'` for is unnecessary here).
 *
 *   toXlsx({ sheets: [{ name, title, subtitle?, tables: [{
 *     heading?, accent?, columns: [{ key, label, type?, width? }], rows, totals?
 *   }] }] })  → Buffer
 *
 * Column types: 'text' (default), 'money' (two decimals, thousands), 'int',
 * 'time' (a Date or ISO string, shown as IST).
 */
import { seesContact, shieldWorkbook } from '../identity/staffContactShield.js';
import { deflateRawSync, crc32 } from 'node:zlib';

/** Heading colours, one per kind of table (§11: a file's palette, not the brand's). */
export const ACCENTS = Object.freeze({
  slate: '334155', green: '15803D', red: 'B91C1C', blue: '1D4ED8',
  purple: '7E22CE', orange: 'C2410C', teal: '0F766E', gold: 'A16207',
});

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s) => String(s)
  // XML 1.0 refuses most control characters; a cell keeps tab and newline only.
  // eslint-disable-next-line no-control-regex -- the control characters are the point
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const IST = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
export function istText(v) {
  if (v === null || v === undefined || v === '') return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = Object.fromEntries(IST.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST`;
}

/** "user_id" or "userId" → "User id": a label for a column given only by its key. */
export function labelOf(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Columns for rows given as plain objects, typed from the values: a Date or
 * ISO time is shown in IST, a key in `money` (or any fraction) with two
 * decimals, any other number as a whole count, the rest as text. `labels` names a column its key
 * would not.
 */
export function columnsOf(rows, { money = [], labels = {} } = {}) {
  if (!rows.length) return [];
  const all = (key, test) => rows.every((r) => r[key] === null || r[key] === undefined || r[key] === '' || test(r[key]));
  return Object.keys(rows[0]).map((key) => {
    let type = 'text';
    if (money.includes(key)) type = 'money';
    else if (all(key, (v) => Number.isInteger(v))) type = 'int';
    else if (all(key, (v) => typeof v === 'number')) type = 'money';
    else if (all(key, (v) => v instanceof Date || (typeof v === 'string' && ISO_TIME.test(v)))) type = 'time';
    return { key, label: labels[key] ?? labelOf(key), type };
  });
}

const colName = (i) => {
  let s = ''; let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// ── Styles ──────────────────────────────────────────────────────────────────
// Fixed: 0 plain, 1 title, 2 subtitle, 3 money, 4 int, 5 text cell, 6 time.
// Then per accent: heading, header, total-label, total-money, total-int.
const FIXED_XF = 7;
const PER_ACCENT = 5;
const accentKeys = Object.keys(ACCENTS);

function stylesXml() {
  const fonts = [
    '<font><sz val="11"/><name val="Calibri"/></font>',
    '<font><b/><sz val="16"/><color rgb="FF0F172A"/><name val="Calibri"/></font>',
    '<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
    ...accentKeys.map((k) => `<font><b/><sz val="13"/><color rgb="FF${ACCENTS[k]}"/><name val="Calibri"/></font>`),
    '<font><b/><sz val="11"/><name val="Calibri"/></font>',
  ];
  const boldFont = fonts.length - 1;
  const fills = [
    '<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
    ...accentKeys.map((k) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${ACCENTS[k]}"/></patternFill></fill>`),
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>',
  ];
  const totalFill = fills.length - 1;
  const borders = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>',
    '<border><left/><right/><top style="medium"><color rgb="FF0F172A"/></top><bottom/><diagonal/></border>',
  ];
  const xf = (font, fill, border, numFmt, extra = '') =>
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"`
    + ` applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"${extra ? ` applyAlignment="1">${extra}</xf>` : '/>'}`;
  const pad = '<alignment vertical="center" indent="1"/>';
  const xfs = [
    xf(0, 0, 0, 0),
    xf(1, 0, 0, 0),
    xf(2, 0, 0, 0),
    xf(0, 0, 1, 164, '<alignment vertical="center"/>'),
    xf(0, 0, 1, 3, '<alignment vertical="center"/>'),
    xf(0, 0, 1, 0, pad),
    xf(0, 0, 1, 0, pad),
  ];
  accentKeys.forEach((_, i) => {
    xfs.push(xf(4 + i, 0, 0, 0));
    xfs.push(xf(3, 2 + i, 0, 0, '<alignment vertical="center" indent="1" wrapText="1"/>'));
    xfs.push(xf(boldFont, totalFill, 2, 0, pad));
    xfs.push(xf(boldFont, totalFill, 2, 164, '<alignment vertical="center"/>'));
    xfs.push(xf(boldFont, totalFill, 2, 3, '<alignment vertical="center"/>'));
  });
  return `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
    + `<fills count="${fills.length}">${fills.join('')}</fills>`
    + `<borders count="${borders.length}">${borders.join('')}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';
}

const accentStyle = (accent, offset) => {
  const i = Math.max(0, accentKeys.indexOf(accent));
  return FIXED_XF + i * PER_ACCENT + offset;
};

// ── Cells ───────────────────────────────────────────────────────────────────
function cell(ref, value, style, type = 'text') {
  if (value === null || value === undefined || value === '') return style ? `<c r="${ref}" s="${style}"/>` : '';
  if ((type === 'money' || type === 'int') && typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  const text = type === 'time' ? istText(value) : String(value);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

const bodyStyle = (type) => ({ money: 3, int: 4, time: 6 }[type] ?? 5);

function sheetXml(sheet) {
  const tables = sheet.tables ?? [];
  const width = Math.max(1, ...tables.map((t) => t.columns.length));
  const rows = [];
  let r = 0;
  const push = (cells, ht) => { r += 1; rows.push(`<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells(r)}</row>`); };

  push((n) => cell(`A${n}`, sheet.title ?? sheet.name, 1), 26);
  if (sheet.subtitle) push((n) => cell(`A${n}`, sheet.subtitle, 2));
  let headerRow = null;
  for (const t of tables) {
    push(() => '');
    if (t.heading) {
      push((n) => cell(`A${n}`, t.heading, accentStyle(t.accent, 0)), 22);
    }
    push((n) => t.columns.map((c, i) => cell(`${colName(i)}${n}`, c.label, accentStyle(t.accent, 1))).join(''), 24);
    if (headerRow === null && tables.length === 1) headerRow = r;
    if (!t.rows.length) {
      push((n) => cell(`A${n}`, t.empty ?? 'Nothing in this range.', 2));
    }
    for (const row of t.rows) {
      push((n) => t.columns.map((c, i) => cell(`${colName(i)}${n}`, row[c.key], bodyStyle(c.type), c.type)).join(''), 20);
    }
    if (t.totals) {
      push((n) => t.columns.map((c, i) => {
        const v = i === 0 && t.totals[c.key] === undefined ? 'Total' : t.totals[c.key];
        const off = c.type === 'money' ? 3 : c.type === 'int' ? 4 : 2;
        return cell(`${colName(i)}${n}`, v ?? '', accentStyle(t.accent, typeof v === 'number' ? off : 2), c.type);
      }).join(''), 22);
    }
  }

  // Widths from the content, within reason; a column may name its own.
  const widths = Array.from({ length: width }, (_, i) => {
    let w = 10;
    for (const t of tables) {
      const c = t.columns[i];
      if (!c) continue;
      if (c.width) { w = Math.max(w, c.width); continue; }
      w = Math.max(w, String(c.label).length + 4);
      for (const row of t.rows.slice(0, 500)) {
        const v = row[c.key];
        const len = c.type === 'time' ? 24 : typeof v === 'number' ? String(Math.round(v)).length + 6 : String(v ?? '').length + 2;
        w = Math.max(w, len);
      }
    }
    return Math.min(w, 60);
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  // A sheet holding one table keeps its header in view while scrolling.
  const pane = headerRow
    ? `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>';
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `${pane}<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols>`
    + `<sheetData>${rows.join('')}</sheetData>`
    + '</worksheet>';
}

/** A sheet name Excel accepts: at most 31 characters, none of []:*?/\, unique. */
function sheetNames(sheets) {
  const seen = new Set();
  return sheets.map((s, i) => {
    let base = String(s.name || `Sheet ${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || `Sheet ${i + 1}`;
    let name = base; let k = 2;
    while (seen.has(name.toLowerCase())) { name = `${base.slice(0, 27)} (${k})`; k += 1; }
    seen.add(name.toLowerCase());
    return name;
  });
}

// ── Zip ─────────────────────────────────────────────────────────────────────
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const raw = Buffer.from(data, 'utf8');
    const packed = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10); dir.writeUInt32LE(0, 12); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

export function toXlsx({ sheets }) {
  if (!sheets?.length) throw new Error('A workbook needs at least one sheet.');
  const names = sheetNames(sheets);
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>' },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><sheets>`
      + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${names.length + 1}" Type="${ns}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(files);
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Send a workbook as a download named `filename` (which ends in .xlsx). */
export function sendXlsx(res, filename, workbook) {
  // A staff download for anyone but a full admin carries no contact or payout
  // column (staffContactShield.js, CLAUDE.md §24); a merchant's own report is
  // not a staff download and is sent whole.
  const viewer = res.req?.user;
  if (viewer?.accountType === 'STAFF' && !seesContact(viewer)) workbook = shieldWorkbook(workbook);
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toXlsx(workbook));
}

/** One sheet holding one table: the shape most downloads take. */
export function oneTable({ name, title, subtitle, heading, accent = 'slate', columns, rows, totals }) {
  return { sheets: [{ name, title, subtitle, tables: [{ heading, accent, columns, rows, totals }] }] };
}
