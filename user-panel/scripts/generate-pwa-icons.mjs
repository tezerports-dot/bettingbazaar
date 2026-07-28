// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Generates the default PWA icons committed under public/app-assets/.
 *
 * ── Why these are committed rather than uploaded ───────────────────────────
 * `/app-assets/:name` is served from the admin branding pipeline, which is
 * EMPTY on a fresh deploy — the backend creates the directory and waits for an
 * upload. Until then every icon URL in manifest.json 404s, and Chrome refuses
 * to offer "Install" at all without a resolvable 192px and 512px icon. So a
 * brand-new deployment shipped a PWA that could not be installed, and an iOS
 * home-screen shortcut with a blank icon.
 *
 * The backend route calls next() when no AppAsset row exists, so these fall
 * through from the SPA bundle and an admin upload still overrides them. They
 * are a floor, not a ceiling.
 *
 * ── Why hand-rolled PNG ────────────────────────────────────────────────────
 * No image library is a dependency of this panel and none should be added for
 * four static files. PNG's stored-block form needs only zlib, which is in the
 * standard library. Regenerate with `npm run icons:generate`.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app-assets');

const BG   = [0x0b, 0x0e, 0x14]; // theme_color / background_color in manifest.json
const GOLD = [0xd4, 0xaf, 0x37]; // the brand accent used across the panels

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Signed distance from a point to a rounded square centred on the canvas. */
function roundedSquareDistance(x, y, size, half, radius) {
  const dx = Math.abs(x - size / 2) - (half - radius);
  const dy = Math.abs(y - size / 2) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * A gold rounded-square ring with a diamond inside it, on the app's dark
 * background. Geometric on purpose: it renders identically at 32px and 512px,
 * and carries no text that would need a font or a translation.
 */
function renderIcon(size, { maskable = false } = {}) {
  // Maskable icons are cropped to a circle by the launcher, so the artwork has
  // to stay inside the safe zone (the middle 80%) or the corners get shaved.
  const scale = maskable ? 0.62 : 0.78;
  const half = (size * scale) / 2;
  const radius = half * 0.28;
  const stroke = Math.max(1.5, size * 0.055);
  const diamond = half * 0.44;
  const aa = Math.max(0.8, size / 220); // antialias width, ~1px at every size

  const rows = [];
  for (let y = 0; y < size; y++) {
    // Filter byte 0 (None) begins every scanline.
    const row = Buffer.alloc(size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Ring: |distance to the rounded square| within half the stroke width.
      const ring = Math.abs(roundedSquareDistance(px, py, size, half, radius)) - stroke / 2;
      // Diamond: an L1 ball at the centre.
      const dia = Math.abs(px - size / 2) + Math.abs(py - size / 2) - diamond;

      // Coverage in [0,1], smoothed across `aa` pixels so edges are not jagged.
      const cov = Math.max(
        1 - Math.min(Math.max(ring / aa + 0.5, 0), 1),
        1 - Math.min(Math.max(dia / aa + 0.5, 0), 1),
      );

      const off = 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        row[off + c] = Math.round(BG[c] + (GOLD[c] - BG[c]) * cov);
      }
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 = truecolour RGB
  // 10..12 = compression, filter, interlace — all 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'favicon-32.png',      size: 32 },
  { file: 'icon-apple-180.png',  size: 180 },              // iOS home screen
  { file: 'icon-192.png',        size: 192 },              // Chrome install minimum
  { file: 'icon-512.png',        size: 512 },              // Chrome install minimum
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const { file, size, maskable } of targets) {
  const png = renderIcon(size, { maskable });
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`  ${file.padEnd(24)} ${size}x${size}  ${String(png.length).padStart(6)} bytes`);
}
console.log(`\n✅ Default PWA icons written to public/app-assets/`);
