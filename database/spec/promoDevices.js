// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The screens a home promo card is drawn for, each with its own image (owner,
 * 2026-10-10: "dont try to fit ... all devices with same image", "make the
 * tablet promo or other images as per that size and detail where will it go").
 *
 * The one owner of this list. The table's CHECK (`promo_image_device_known`,
 * schema.sql) names the same keys; the admin Images page and the player app
 * read the rest from the API (`devices` beside the cards), so neither keeps a
 * copy of a size or a place.
 *
 *   key       — the stored device (`promo_content_images.device`)
 *   minWidth  — the narrowest screen, in CSS pixels, that uses this image
 *   maxWidth  — the widest (null: no upper bound)
 *   ratio     — the card's frame, width : height. The player draws exactly
 *               this frame, so an image of this shape is shown edge to edge
 *   upload    — the pixel size to make the image (2–3× the frame, for sharp
 *               screens)
 *   where     — where on the player's screen the card appears
 *   examples  — which devices fall in the range
 *
 * The player app's breakpoints (user-panel/src/redesign/useViewport.ts) are
 * the same numbers: LAPTOP is its `desktop`, TABLET its `tablet`, and its
 * `mobile` splits at SMALL_PHONE's `maxWidth`.
 */

export const PROMO_DEVICES = Object.freeze([
  Object.freeze({
    key: 'LAPTOP', label: 'Laptop / desktop', minWidth: 1000, maxWidth: null,
    ratio: Object.freeze({ w: 16, h: 9 }), upload: Object.freeze({ w: 1200, h: 675 }),
    where: 'Side columns beside the game board, stacked under Refer & Earn and My open bets.',
    examples: 'Laptops and desktop monitors, 1000 px wide and up',
  }),
  Object.freeze({
    key: 'TABLET', label: 'Tablet', minWidth: 680, maxWidth: 999,
    ratio: Object.freeze({ w: 5, h: 1 }), upload: Object.freeze({ w: 2000, h: 400 }),
    where: 'Full-width banner just under the header, above the game tabs; swiped one at a time.',
    examples: 'iPad, iPad mini, Android tablets, a phone held sideways',
  }),
  Object.freeze({
    key: 'PHONE', label: 'Phone', minWidth: 370, maxWidth: 679,
    ratio: Object.freeze({ w: 3, h: 1 }), upload: Object.freeze({ w: 1170, h: 390 }),
    where: 'Full-width banner just under the header, above the game tabs; swiped one at a time.',
    examples: 'iPhone 12–16, iPhone SE (375 px), Pixel, most Android phones (390–430 px)',
  }),
  Object.freeze({
    key: 'SMALL_PHONE', label: 'Small phone', minWidth: 0, maxWidth: 369,
    ratio: Object.freeze({ w: 18, h: 5 }), upload: Object.freeze({ w: 1080, h: 300 }),
    where: 'Full-width banner just under the header, kept short so the chips stay on screen.',
    examples: 'Compact Android phones (360 px, e.g. many Samsung Galaxy A models), 320 px phones',
  }),
]);

export const PROMO_DEVICE_KEYS = Object.freeze(PROMO_DEVICES.map((d) => d.key));

export const isPromoDevice = (key) => PROMO_DEVICE_KEYS.includes(key);

export default PROMO_DEVICES;
