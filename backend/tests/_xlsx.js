// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Reads back a workbook a route sent (`xlsx.util.js`), so a test asserts the
// cells a person opening the download sees. Test-only, dependency-free.
import { inflateRawSync } from 'node:zlib';

/** supertest: keep the body as bytes (`.buffer(true).parse(binary)`). */
export function binary(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

function unzip(buf) {
  const files = new Map();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** { [sheet name]: rows of cells (string or number; '' for an empty cell) }. */
export function readXlsx(buf) {
  const files = unzip(buf);
  const names = [...files.get('xl/workbook.xml').matchAll(/<sheet name="([^"]*)"/g)].map((m) => unesc(m[1]));
  const out = {};
  names.forEach((name, i) => {
    const xml = files.get(`xl/worksheets/sheet${i + 1}.xml`);
    out[name] = [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/g)].map((row) => {
      const cells = [];
      for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
        const body = c[2] ?? '';
        const text = /<t[^>]*>(.*?)<\/t>/.exec(body);
        const num = /<v>(.*?)<\/v>/.exec(body);
        cells[colIndex(c[1])] = text ? unesc(text[1]) : num ? Number(num[1]) : '';
      }
      return Array.from(cells, (v) => v ?? '');
    });
  });
  return out;
}

/**
 * The one table of a one-table download: its header and its rows as cell
 * arrays (the title, subtitle and any totals line left out).
 */
export function onlyTable(book) {
  const [rows] = Object.values(book);
  const start = rows.findIndex((r, i) => i > 0 && r.length > 1);
  const header = rows[start] ?? [];
  const body = [];
  for (const r of rows.slice(start + 1)) {
    if (!r.length || r.every((v) => v === '') || r[0] === 'Total') break;
    body.push(r);
  }
  return { header, rows: body, cell: (row, label) => row[header.indexOf(label)] };
}

/** GET a download as a parsed workbook (supertest request in, `{ res, book }` out). */
export async function getXlsx(req) {
  const res = await req.buffer(true).parse(binary);
  return { res, book: res.status === 200 ? readXlsx(res.body) : null };
}
