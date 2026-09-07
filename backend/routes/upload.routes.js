// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express from 'express';
import { db } from '#db';
import cdnService from '../services/cdn.service.js';
import { authenticate, isAdmin } from '../domains/identity/auth.middleware.js';
import { merchantAuth } from '../middleware/merchantAuth.js';
// Order chat. An attachment that is not recorded is an upload nobody can find.

const router = express.Router();

/**
 * The order, if this PLAYER owns it.
 *
 * Six handlers repeated the same lookup — an `$or` over an order id and an
 * ObjectId — and then compared `order.userId` after the fetch. The comparison
 * is an authorisation boundary, so it lives in one place a new handler cannot
 * be written without.
 *
 * Returns null for "does not exist" and "not yours" alike. A distinguishable
 * 404-vs-403 tells somebody probing order ids which ones are real.
 */
async function playerOrder(orderId, userId) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) return null;
  return String(order.userId) === String(userId) ? order : null;
}

/** The order, if this MERCHANT holds it. Same reasoning as above. */
async function merchantOrder(orderId, merchantId) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) return null;
  return String(order.merchantId) === String(merchantId) ? order : null;
}

function hasValidUploadInput(fileName, contentType, fileSize) {
  return typeof fileName === 'string' && fileName.trim() &&
    typeof contentType === 'string' && contentType.trim() &&
    Number.isFinite(fileSize) && fileSize > 0;
}

// ═══════════════════════════════════════════════════════════════════════


// Validates that the requesting user owns the order before issuing

// by the merchant panel and does a participant check).
// ═══════════════════════════════════════════════════════════════════════
// 💬 ORDER CHAT ATTACHMENTS — REMOVED
//
// `/user/chat/:orderId/{upload-url,confirm-upload}` and the merchant pair are
// gone, with the `GET|POST /api/merchant/chat/:id` routes they fed.
//
// There is no merchant-to-user order chat, by design. A player submits a UTR
// as proof that they paid; the merchant matches it against their own bank
// statement and confirms or rejects. The two never negotiate, which is the
// point: a private channel between the party holding the money and the party
// owed it is where an off-platform settlement gets agreed.
//
// The one conversation that exists is the DISPUTE chat, and it is between the
// player and an admin or sub-admin — see
// domains/disputes/disputeResolution.admin.routes.js. That still uses
// `chat.js`, which is why the repository stays: `postSystemMessage` also writes
// the order's own timeline, which is the record a dispute is decided from.
//
// The merchant QR presign below is NOT part of this. It uploads a merchant's
// own UPI QR image for their profile, and has nothing to do with order chat.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// 📸 PAYMENT PROOF — REMOVED
//
// `/user/payment-proof/:orderId/{upload-url,confirm-upload}` are gone. The
// deposit flow no longer collects a payment screenshot: it proved nothing (it
// is trivially forged and no approval read it), while the merchant matches the
// UTR against their own bank statement, which is the only part of the
// submission the platform can verify. Collecting an identifying image that no
// decision reads is data a platform should not hold.
//
// `proofScreenshot` remains on the order and `cdn.service.js` still knows the
// `payment-proof` category, so an image already stored is still served and the
// retention job still expires it. Only the collection of new ones is gone.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// 🪪 KYC DOCUMENTS — REMOVED 2026-08-25
//
// POST /user/kyc/:docType/upload-url presigned a PUT into a private bucket
// for an Aadhaar card and a selfie, which an admin then reviewed by eye.
// KYC no longer works that way: the Telegram bot captures the Aadhaar NUMBER,
// it is held encrypted, and verification happens in bulk against the issuing
// authority (domains/identity/kycBulk.service.js). There is no document to
// upload, so there is no bucket to presign into — and the safest identity
// document is the one never collected.
//
// Do not re-add an upload endpoint here without the private-store guarantees
// that used to sit on this one; docs/IDENTITY_AND_REFERRALS.md §6a records them.
// ═══════════════════════════════════════════════════════════════════════

// ── Profile picture upload (used by profile page) ────────────────────────────
router.post('/user/profile/picture/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType, fileSize } = req.body;
    if (!hasValidUploadInput(fileName, contentType, fileSize))
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize required' });
    const PIC_ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const cleanPicMime = contentType.toLowerCase().split(';')[0].trim();
    if (!PIC_ALLOWED.includes(cleanPicMime))
      return res.status(400).json({ success: false, message: 'Only JPG, PNG, WebP images allowed' });
    if (fileSize > 10 * 1024 * 1024)
      return res.status(400).json({ success: false, message: 'Max file size is 10 MB' });
    const uploadData = await cdnService.generatePresignedUploadUrl({
      fileName, contentType, fileSize,
      category: 'profile', userId: req.user.userId.toString()
    });
    res.json({ success: true, ...uploadData });
  } catch (err) {
    console.error('Profile picture upload-url error:', err.message);
    res.status(503).json({ success: false, message: 'CDN storage is not configured. File upload is unavailable.' });
  }
});

router.post('/user/profile/picture/confirm-upload', authenticate, async (req, res) => {
  try {
    const { fileKey, cdnUrl } = req.body;
    if (!fileKey || !cdnUrl) return res.status(400).json({ success: false, message: 'fileKey and cdnUrl are required' });
    const verified = await cdnService.verifyUploadedObject({
      fileKey, cdnUrl, expectedUserId: req.user.userId.toString(), expectedCategory: 'profile'
    });
    await db.users.updateUser(req.user.userId, { profilePic: verified.cdnUrl });
    res.json({ success: true, cdnUrl: verified.cdnUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/upload/merchant/qr/upload-url — Merchant QR code image upload ─
// Merchant uploads a QR image; we return a presigned S3 URL for direct upload.
// After upload, merchant calls PUT /api/merchant/profile with { qrCodeUrl: cdnUrl }.
router.post('/merchant/qr/upload-url', merchantAuth, async (req, res) => {
  try {
    const { fileName, contentType, fileSize } = req.body;
    if (!hasValidUploadInput(fileName, contentType, fileSize)) return res.status(400).json({ success: false, message: 'fileName and contentType are required' });

    const QR_ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
    const cleanMime  = contentType.toLowerCase().split(';')[0].trim();
    if (!QR_ALLOWED.includes(cleanMime))
      return res.status(400).json({ success: false, message: 'Only JPG, PNG, WebP allowed for QR code images' });
    if (fileSize > 5 * 1024 * 1024)
      return res.status(400).json({ success: false, message: 'Max file size is 5 MB' });

    const uploadData = await cdnService.generatePresignedUploadUrl({
      fileName, contentType, fileSize,
      category: 'merchant-qr', userId: req.merchantId.toString(),
    });
    res.json({ success: true, ...uploadData });
  } catch (err) {
    console.error('Merchant QR upload-url error:', err.message);
    res.status(503).json({ success: false, message: 'CDN storage is not configured. File upload is unavailable.' });
  }
});

export default router;
