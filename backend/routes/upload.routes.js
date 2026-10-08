// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)


import express from 'express';
import { db } from '#db';
import cdnService from '../services/cdn.service.js';
import { authenticatePlayer } from '../domains/identity/auth.middleware.js';
import { merchantAuth } from '../middleware/merchantAuth.js';
import { unpaidRejectRefusal } from '../domains/payment/rejectedBuyWindow.service.js';
import { serverError, callerError, respondError } from '../shared/httpError.js';
// Order chat. An attachment that is not recorded is an upload nobody can find.

const router = express.Router();

// An order's owner is checked in the read's WHERE (`getMerchantOrder`), never
// compared after a fetch: "does not exist" and "not yours" answer alike.

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
    // The same question the reject asks, from the same function (§32 S3): a
    // buy the player has tapped Paid on (owner, 2026-10-07). This admitted
    // PROCESSING, and any order type, so evidence could be staged for an
    // accusation that cannot be made.
    const refused = unpaidRejectRefusal(order);
    if (refused) {
      return res.status(refused.status).json({ success: false, code: refused.code, message: refused.message });
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
// KYC DOCUMENTS — none. No identity document is collected, and since
// 2026-10-02 no identity number either (KYC removed, owner). Do not add an
// upload path for one.
// ═══════════════════════════════════════════════════════════════════════

// ── Profile picture upload (used by profile page) ────────────────────────────
router.post('/user/profile/picture/upload-url', authenticatePlayer, async (req, res) => {
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

router.post('/user/profile/picture/confirm-upload', authenticatePlayer, async (req, res) => {
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
// QR itself. A static image could not carry the order amount. A cash buy is
// now paid through the ATM QR the member scans per order (Step 2d), and a
// UPI/bank buy by bank transfer to the member's account (owner, 2026-10-03).

export default router;
