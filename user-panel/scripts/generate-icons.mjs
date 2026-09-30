// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Generates every committed app icon: the PWA set under public/app-assets/ AND
 * the Android launcher icons, adaptive-icon foreground, splash screens and
 * background colour under android/app/src/main/res/.
 *
 *   npm run icons:generate            write them
 *   npm run icons:generate -- --check exit 1 if any committed file differs
 *
 * ── One mark, one renderer ─────────────────────────────────────────────────
 * The Android project shipped Capacitor's template placeholders — a blue "X"
 * on a white tile, and the same X on a white splash — while the web app used
 * this script's gold mark on the app's dark background. An installed APK was
 * therefore the only place the product did not look like itself, and the
 * white splash flashed before a dark app. Both sets now come from here, so the
 * launcher, the splash and the browser tab cannot drift apart (§2, §5). The
 * `--check` mode is run by the Android build check, so a hand-edited PNG or a
 * geometry change without a regeneration fails a pull request.
 *
 * ── Why these are committed rather than uploaded ───────────────────────────
 * `/app-assets/:name` is served from the admin branding pipeline, which is
 * EMPTY on a fresh deploy — the backend creates the directory and waits for an
 * upload. Until then every icon URL in manifest.json 404s, and Chrome refuses
 * to offer "Install" at all without a resolvable 192px and 512px icon. So a
 * brand-new deployment shipped a PWA that could not be installed, and an iOS
 * home-screen shortcut with a blank icon. The backend route calls next() when
 * no AppAsset row exists, so these fall through from the SPA bundle and an
 * admin upload still overrides them. They are a floor, not a ceiling.
 *
 * The Android set is different in one way worth knowing: it is compiled INTO
 * the APK, so an admin's branding upload cannot change a launcher icon. That is
 * how Android works, not a gap here — changing it is a new build.
 *
 * ── Why hand-rolled PNG ────────────────────────────────────────────────────
 * No image library is a dependency of this panel and none should be added for
 * static files. PNG needs only zlib, which is in the standard library.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const PWA_DIR = join(PANEL, 'public', 'app-assets');
const RES_DIR = join(PANEL, 'android', 'app', 'src', 'main', 'res');

// theme_color / background_color in public/manifest.json. The Android colour
// resource and capacitor.config.ts's backgroundColor mirror it, and
// src/services/nativeBrand.test.ts fails if either disagrees.
const BG   = [0x0b, 0x0e, 0x14];
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

/** Signed distance from a point to a rounded square centred at (cx, cy). */
function roundedSquareDistance(x, y, cx, cy, half, radius) {
  const dx = Math.abs(x - cx) - (half - radius);
  const dy = Math.abs(y - cy) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance → coverage in [0,1], smoothed across `aa` pixels. */
const coverage = (d, aa) => 1 - Math.min(Math.max(d / aa + 0.5, 0), 1);

/**
 * A gold rounded-square ring with a diamond inside it. Geometric on purpose:
 * it renders identically at 32px and 1920px, and carries no text that would
 * need a font or a translation.
 *
 * @param width,height  canvas in pixels
 * @param half          half the ring's outer width, in pixels
 * @param stroke        ring thickness, in pixels
 * @param ground        'solid'       dark background, RGB (every PWA icon)
 *                      'transparent' mark only, RGBA (adaptive foreground —
 *                                    the launcher supplies the background)
 *                      'disc'        dark disc on transparent, RGBA (the
 *                                    pre-Android-8 round icon)
 */
function render(width, height, { half, stroke, ground = 'solid' }) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = half * 0.28;
  const diamond = half * 0.44;
  const aa = Math.max(0.8, Math.min(width, height) / 220); // ~1px at every size
  const rgba = ground !== 'solid';
  const bpp = rgba ? 4 : 3;

  const rows = [];
  for (let y = 0; y < height; y++) {
    // Filter byte 0 (None) begins every scanline.
    const row = Buffer.alloc(width * bpp + 1);
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Ring: |distance to the rounded square| within half the stroke width.
      const ring = Math.abs(roundedSquareDistance(px, py, cx, cy, half, radius)) - stroke / 2;
      // Diamond: an L1 ball at the centre.
      const dia = Math.abs(px - cx) + Math.abs(py - cy) - diamond;
      const cov = Math.max(coverage(ring, aa), coverage(dia, aa));

      const off = 1 + x * bpp;
      if (ground === 'transparent') {
        for (let c = 0; c < 3; c++) row[off + c] = GOLD[c];
        row[off + 3] = Math.round(255 * cov);
        continue;
      }
      for (let c = 0; c < 3; c++) row[off + c] = Math.round(BG[c] + (GOLD[c] - BG[c]) * cov);
      if (ground === 'disc') {
        const r = Math.min(width, height) / 2;
        const disc = Math.hypot(px - cx, py - cy) - r;
        row[off + 3] = Math.round(255 * coverage(disc, aa));
      }
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;               // bit depth
  ihdr[9] = rgba ? 6 : 2;    // colour type: 6 = RGBA, 2 = RGB
  // 10..12 = compression, filter, interlace — all 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── PWA ────────────────────────────────────────────────────────────────────
// Byte-identical to what this script produced before it learned Android: the
// stroke is a fraction of the CANVAS here, as it always was.
function pwaIcon(size, { maskable = false } = {}) {
  // Maskable icons are cropped to a circle by the launcher, so the artwork has
  // to stay inside the safe zone (the middle 80%) or the corners get shaved.
  const scale = maskable ? 0.62 : 0.78;
  return render(size, size, { half: (size * scale) / 2, stroke: Math.max(1.5, size * 0.055) });
}

// ── Android ────────────────────────────────────────────────────────────────
// Stroke as a fraction of the MARK (0.141 × half is what the 0.78 PWA icon
// works out to), so a mark drawn smaller keeps the same proportions.
const STROKE_OF_HALF = 0.141;
const markAt = (half) => ({ half, stroke: Math.max(1.5, half * STROKE_OF_HALF) });

/**
 * The adaptive-icon foreground: a 108dp canvas of which a launcher shows at
 * most the central 72dp, and guarantees only a 66dp-diameter circle (every
 * mask shape — circle, squircle, teardrop — contains it). The ring's rounded
 * corners are its furthest point from the centre, at about 1.30 × half, so
 * half = 0.46 / 2 of the canvas puts them at 0.299 — inside 33/108 = 0.306.
 */
const adaptiveForeground = (px) => render(px, px, { ...markAt((px * 0.46) / 2), ground: 'transparent' });

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/** The splash sizes Capacitor's template ships, which Android picks by density. */
const SPLASH = {
  'drawable':               [480, 320],
  'drawable-land-mdpi':     [480, 320],
  'drawable-land-hdpi':     [800, 480],
  'drawable-land-xhdpi':    [1280, 720],
  'drawable-land-xxhdpi':   [1600, 960],
  'drawable-land-xxxhdpi':  [1920, 1280],
  'drawable-port-mdpi':     [320, 480],
  'drawable-port-hdpi':     [480, 800],
  'drawable-port-xhdpi':    [720, 1280],
  'drawable-port-xxhdpi':   [960, 1600],
  'drawable-port-xxxhdpi':  [1280, 1920],
};

const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();

function colourResource() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.) -->
<!-- GENERATED by scripts/generate-icons.mjs — edit BG there, not here.
     Mirrors theme_color in public/manifest.json. -->
<resources>
    <!-- Behind the adaptive launcher icon's gold mark. -->
    <color name="ic_launcher_background">${hex(BG)}</color>
    <!-- The Android 12+ system splash and the window behind the WebView, so a
         dark app never opens on a white frame. -->
    <color name="brand_background">${hex(BG)}</color>
</resources>
`;
}

// ── Targets ────────────────────────────────────────────────────────────────
const targets = [
  { path: join(PWA_DIR, 'favicon-32.png'),        make: () => pwaIcon(32) },
  { path: join(PWA_DIR, 'icon-apple-180.png'),    make: () => pwaIcon(180) },   // iOS home screen
  { path: join(PWA_DIR, 'icon-192.png'),          make: () => pwaIcon(192) },   // Chrome install minimum
  { path: join(PWA_DIR, 'icon-512.png'),          make: () => pwaIcon(512) },   // Chrome install minimum
  { path: join(PWA_DIR, 'icon-maskable-512.png'), make: () => pwaIcon(512, { maskable: true }) },
];

for (const [density, k] of Object.entries(DENSITIES)) {
  const dir = join(RES_DIR, `mipmap-${density}`);
  const legacy = Math.round(48 * k);   // launcher icon, 48dp
  targets.push(
    // Android 7.x (minSdk 24) draws these as they are — no mask, no background.
    { path: join(dir, 'ic_launcher.png'),       make: () => pwaIcon(legacy) },
    { path: join(dir, 'ic_launcher_round.png'), make: () => render(legacy, legacy, { ...markAt((legacy * 0.62) / 2), ground: 'disc' }) },
    // Android 8+ composes this over @color/ic_launcher_background (mipmap-anydpi-v26).
    { path: join(dir, 'ic_launcher_foreground.png'), make: () => adaptiveForeground(Math.round(108 * k)) },
  );
}

for (const [dir, [w, h]] of Object.entries(SPLASH)) {
  targets.push({
    path: join(RES_DIR, dir, 'splash.png'),
    make: () => render(w, h, markAt((Math.min(w, h) * 0.30) / 2)),
  });
}

targets.push({ path: join(RES_DIR, 'values', 'ic_launcher_background.xml'), make: () => Buffer.from(colourResource()) });

// ── Run ────────────────────────────────────────────────────────────────────
const check = process.argv.includes('--check');
const stale = [];

for (const { path, make } of targets) {
  const bytes = make();
  const rel = relative(PANEL, path);
  if (check) {
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) stale.push(rel);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`  ${rel.padEnd(62)} ${String(bytes.length).padStart(7)} bytes`);
}

if (check) {
  if (stale.length) {
    console.error(`✖ ${stale.length} committed icon file(s) differ from what scripts/generate-icons.mjs produces:`);
    for (const s of stale) console.error(`    ${s}`);
    console.error('  Run `npm run icons:generate` in user-panel/ and commit the result.');
    process.exit(1);
  }
  console.log(`✅ All ${targets.length} icon files match the generator.`);
} else {
  console.log(`\n✅ ${targets.length} icon files written (PWA + Android).`);
}
