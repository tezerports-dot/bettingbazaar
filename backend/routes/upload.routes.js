// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)


import express from 'express';
import { db } from '#db';
import cdnService from '../services/cdn.service.js';
import { authenticate, isAdmin } from '../domains/identity/auth.middleware.js';
import { merchantAuth } from '../middleware/merchantAuth.js';
import { serverError, callerError, respondError } from '../shared/httpError.js';
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
// 🧾 MERCHANT ORDER-REJECTION PROOF
//
// A merchant rejecting a PAID order is saying the player's money never
// arrived. That warns and flags the player's account and puts them in an
// admin's review queue, so the accusation carries evidence: a bank statement
// screenshot or a photo showing no such credit. The admin decides from this
// image, so an unverifiable one is a decision made blind.
//
// The order must be the merchant's own and must be in a state where the claim
// makes sense. Issuing a URL for somebody else's order would let a merchant
// stage proof against an order they have nothing to do with.
// ═══════════════════════════════════════════════════════════════════════
router.post('/merchant/order-reject-proof/:orderId/upload-url', merchantAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileName, contentType, fileSize } = req.body;

    if (!hasValidUploadInput(fileName, contentType, fileSize)) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize are required' });
    }
    if (fileSize > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'Maximum file size is 10 MB' });
    }

    // Ownership in the WHERE clause — `getMerchantOrder` matches the order id
    // AND the merchant id, so an order that is not theirs is simply not found.
    const order = await db.orders.getMerchantOrder(orderId, req.merchantId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['PAID', 'PROCESSING'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Proof applies to a paid order. This one is ${order.status}.`,
      });
    }

    // Images only — the category falls through to the image allowlist, and the
    // extension blocklist independently refuses SVG and HTML, which served from
    // the panels' own origin would be stored XSS.
    const uploadData = await cdnService.generatePresignedUploadUrl({
      fileName, contentType, fileSize,
      category: 'merchant-reject-proof',
      userId: String(req.merchantId),
      orderId,
    });
    res.json({ success: true, ...uploadData });
  } catch (error) {
    console.error('❌ Merchant reject-proof upload URL error:', error);
    return respondError(res, error, 'POST /upload/merchant/order-reject-proof/:orderId/upload-url', { message: 'Failed to generate upload URL' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 🏧 CDM RECEIPT — the evidence for a cash payout
//
// Staged against THIS merchant and THIS order, same as the reject proof above:
// ownership is in the WHERE clause, so an order that is not theirs is simply
// not found and they cannot stage evidence against one.
//
// The stored receipt is write-only afterwards — not even the merchant who
// uploaded it can read it back, only an admin or a disputes manager. That is
// why the panel must let them REPLACE the file freely before submitting: this
// upload step is the last point at which they can check what they are sending.
// ═══════════════════════════════════════════════════════════════════════
router.post('/merchant/cdm-receipt/:orderId/upload-url', merchantAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileName, contentType, fileSize } = req.body;

    if (!hasValidUploadInput(fileName, contentType, fileSize)) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize are required' });
    }
    if (fileSize > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'Maximum file size is 10 MB' });
    }

    const order = await db.orders.getMerchantOrder(orderId, req.merchantId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.type !== 'WITHDRAWAL') {
      return res.status(400).json({
        success: false,
        message: 'A CDM receipt belongs to a payout, not a purchase.',
      });
    }

    // Images only — the category falls through to the image allowlist, and the
    // extension blocklist independently refuses SVG and HTML.
    const uploadData = await cdnService.generatePresignedUploadUrl({
      fileName, contentType, fileSize,
      category: 'cdm-receipt',
      userId: String(req.merchantId),
      orderId,
    });
    res.json({ success: true, ...uploadData });
  } catch (error) {
    console.error('❌ CDM receipt upload URL error:', error);
    return respondError(res, error, 'POST /upload/merchant/cdm-receipt/:orderId/upload-url', { message: 'Failed to generate upload URL' });
  }
});

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
    // Split deliberately. `verifyUploadedObject` refuses with messages written
    // for the caller — the key is not theirs, the bytes are not the type they
    // claimed — and those are the caller's mistake, so 400 with the wording
    // intact. Anything else is ours, and says nothing.
    let verified;
    try {
      verified = await cdnService.verifyUploadedObject({
        fileKey, cdnUrl, expectedUserId: req.user.userId.toString(), expectedCategory: 'profile'
      });
    } catch (err) {
      return callerError(res, err);
    }
    await db.users.updateUser(req.user.userId, { profilePic: verified.cdnUrl });
    res.json({ success: true, cdnUrl: verified.cdnUrl });
  } catch (err) {
    return serverError(res, err, 'POST /user/profile/picture/confirm-upload');
  }
});

// The merchant QR upload route lived here and was DELETED 2026-09-10 with the
// QR itself. A merchant supplies a UPI ID and nothing else on the INR rail:
// `upiPaymentLink()` builds a dynamic `upi://pay` intent per order, with that
// order's amount already in it, so the player taps and their own UPI app opens
// filled in. A stored QR image was a second, static way to say the same thing —
// and being static it could not carry the amount, which is the whole point.

export default router;
