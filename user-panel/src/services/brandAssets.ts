// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/brandAssets.ts — where this panel's logo and splash images come from.
 *
 * ── The failure this fixes ─────────────────────────────────────────────────
 * Every screen wrote `/app-assets/logo.png` as a RELATIVE path. On the web that
 * reaches the server, which serves whatever the admin uploaded on the App
 * Assets page. Inside the Android app the page is `https://localhost`, so the
 * same path resolved to the files bundled INTO the APK — where no logo.png
 * exists. Nothing an admin uploaded ever appeared in the app, and the image
 * fell back to `/logo.png`, which does not exist either: a broken image on the
 * loading screen of every install.
 *
 * So there are two kinds of image, and this module is the one place that says
 * which is which:
 *
 *   uploadedAsset(slot)  an admin-managed slot, fetched from the SERVER — the
 *                        API origin in the app, same origin on the web
 *   BUNDLED_MARK         the brand mark generated into every build
 *                        (scripts/generate-icons.mjs) — always there, offline
 *                        included, and the placeholder when nothing is uploaded
 *
 * It also replaces two identical copies of `resolveLogo` (the auth modal and
 * the shell), which is §5's warning about one value assembled twice.
 */
import { useEffect, useState } from 'react';
import { apiUrl } from './apiUrl';

/** Generated into public/app-assets/ and therefore into every build. */
export const BUNDLED_MARK = '/app-assets/icon-512.png';

/**
 * The wordmark drawn in the header and on the sign-in card: the owner's
 * artwork, cropped to its painted pixels, in public/brand/ and so in every
 * build (the APK included, where `/app-assets/` would not reach it).
 */
export const BUNDLED_HEADER_LOGO = '/brand/logo-header.webp';

/** An admin-uploaded App Assets slot (see branding.admin.routes.js ASSET_SLOTS). */
export function uploadedAsset(slot: 'logo.png' | 'logo-header.png' | 'splash.png'): string {
  return apiUrl(`/app-assets/${slot}`);
}

/**
 * The logo to show: the Branding document's logo when an admin set one (an
 * absolute CDN URL, or a path under its cdnBaseUrl), else the uploaded slot.
 * A screen pairs it with `fallBackToMark` so a missing upload shows the mark.
 */
export function brandLogo(slot: 'logo.png' = 'logo.png'): string {
  try {
    const b = JSON.parse(localStorage.getItem('app_branding') || '{}');
    const cdn = String(b.cdnBaseUrl || '').replace(/\/+$/, '');
    if (b.logo) return String(b.logo).startsWith('http') ? b.logo : `${cdn}/${String(b.logo).replace(/^\/+/, '')}`;
  } catch { /* unreadable cache — use the slot */ }
  return uploadedAsset(slot);
}

/**
 * `onError` for any brand <img>: swap to the bundled mark, once. The guard
 * matters — without it a missing mark would re-fire onError for ever.
 */
export function fallBackToMark(e: { currentTarget: HTMLImageElement }): void {
  const img = e.currentTarget;
  if (img.dataset.fellBack) return;
  img.dataset.fellBack = '1';
  img.src = BUNDLED_MARK;
}

/**
 * The header wordmark. The bundled artwork paints at once; the App Assets
 * `logo-header.png` slot replaces it only once it has actually loaded, so an
 * empty slot (a 404) never blanks the header or flashes a broken image.
 *
 * It deliberately does not read Branding's `logo`: that is the square logo of
 * the loading screen, and drawn into a wide header slot it was what overflowed
 * onto the buttons beside it.
 */
export function useHeaderLogo(): string {
  const [src, setSrc] = useState(BUNDLED_HEADER_LOGO);
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => { if (live && img.naturalWidth > 0) setSrc(img.src); };
    img.src = uploadedAsset('logo-header.png');
    return () => { live = false; img.onload = null; };
  }, []);
  return src;
}
