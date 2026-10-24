// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a promo slide may be: an image anywhere, a video only as a Pro Tips
 * reel (owner, 2026-10-24). The Rules page draws every slide as an image, so a
 * video there would be a broken picture. The table's `promo_media_known` CHECK
 * holds the vocabulary; this refuses first, with a message the admin can act
 * on, on both the create and the edit path.
 */
export const PROMO_MEDIA = Object.freeze(['IMAGE', 'VIDEO', 'TEXT']);

/** Where a video slide may go. */
export const VIDEO_LOCATIONS = Object.freeze(['TRICKS_PAGE']);

/** The upper-cased media type, or a 400 saying why it is refused. */
export function promoMediaFor(mediaType, location) {
  const media = String(mediaType || 'IMAGE').toUpperCase();
  const where = String(location || '').toUpperCase();
  const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!PROMO_MEDIA.includes(media)) refuse(`Unknown media type: ${mediaType}. Use an image or a video.`);
  if (media === 'VIDEO' && !VIDEO_LOCATIONS.includes(where)) {
    refuse('A video can only be a Pro Tips reel. Use an image here.');
  }
  return media;
}

export default promoMediaFor;
