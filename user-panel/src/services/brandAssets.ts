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
import { apiUrl } from './apiUrl';

/** Generated into public/app-assets/ and therefore into every build. */
export const BUNDLED_MARK = '/app-assets/icon-512.png';

/** An admin-uploaded App Assets slot (see branding.admin.routes.js ASSET_SLOTS). */
export function uploadedAsset(slot: 'logo.png' | 'logo-header.png' | 'splash.png'): string {
  return apiUrl(`/app-assets/${slot}`);
}

/**
 * The logo to show: the Branding document's logo when an admin set one (an
 * absolute CDN URL, or a path under its cdnBaseUrl), else the uploaded slot.
 * A screen pairs it with `fallBackToMark` so a missing upload shows the mark.
 */
export function brandLogo(slot: 'logo.png' | 'logo-header.png' = 'logo.png'): string {
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
