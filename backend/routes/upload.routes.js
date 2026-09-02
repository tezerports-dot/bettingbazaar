// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express from 'express';
import { db } from '#db';
import cdnService from '../services/cdn.service.js';
import { authenticate, isAdmin } from '../domains/identity/auth.middleware.js';
import { merchantAuth } from '../middleware/merchantAuth.js';
// Order chat. An attachment that is not recorded is an upload nobody can find.
import { postMessage } from '#db/repositories/chat.js';

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

router.post('/user/chat/:orderId/upload-url', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileName, contentType, fileSize } = req.body;

    if (!hasValidUploadInput(fileName, contentType, fileSize)) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize are required' });
    }

    const CHAT_ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const cleanMime = contentType.toLowerCase().split(';')[0].trim();
    if (!CHAT_ALLOWED.includes(cleanMime)) {
      return res.status(400).json({ success: false, message: 'Only JPEG, PNG, WebP, and GIF images are allowed' });
    }

    const chatMimeRule = cdnService.mimeRulesForCategory('chat')[cleanMime];
    if (fileSize > chatMimeRule.maxSize) {
      return res.status(400).json({ success: false, message: `Max file size is ${chatMimeRule.maxSize / (1024 * 1024)} MB` });
    }

    const order = await playerOrder(orderId, req.user.userId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const result = await cdnService.generateChatUploadUrl(
      fileName, contentType, fileSize,
      req.user.userId.toString(), orderId
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('User chat upload-url error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to generate upload URL' });
  }
});

router.post('/user/chat/:orderId/confirm-upload', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileKey, cdnUrl, message } = req.body;

    if (!fileKey || !cdnUrl) {
      return res.status(400).json({ success: false, message: 'fileKey and cdnUrl are required' });
    }

    const order = await playerOrder(orderId, req.user.userId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const verified = await cdnService.verifyUploadedObject({
      fileKey, cdnUrl, expectedUserId: req.user.userId.toString(), expectedOrderId: orderId, expectedCategory: 'chat'
    });

    const chatMsg = await postMessage({
      orderId:       order.orderId,
      senderId:      req.user.userId,
      senderType:    'USER',
      message:       message || '📎 Attachment',
      attachmentUrl: verified.cdnUrl,
      attachmentKey: verified.fileKey,
      isSystem:      false,
    });

    global.io?.to(`order-${order._id}`).emit('newMessage', chatMsg);

    res.json({ success: true, message: chatMsg });
  } catch (err) {
    console.error('User chat confirm-upload error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to save message' });
  }
});

// ═══════════════════════════════════════════════════════════════════════


// Validates that the requesting merchant owns the order.
// ═══════════════════════════════════════════════════════════════════════

router.post('/merchant/chat/:orderId/upload-url', merchantAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileName, contentType, fileSize } = req.body;

    if (!hasValidUploadInput(fileName, contentType, fileSize)) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize are required' });
    }

    const CHAT_ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const cleanMime = contentType.toLowerCase().split(';')[0].trim();
    if (!CHAT_ALLOWED.includes(cleanMime)) {
      return res.status(400).json({ success: false, message: 'Only JPEG, PNG, WebP, and GIF images are allowed' });
    }

    const chatMimeRule = cdnService.mimeRulesForCategory('chat')[cleanMime];
    if (fileSize > chatMimeRule.maxSize) {
      return res.status(400).json({ success: false, message: `Max file size is ${chatMimeRule.maxSize / (1024 * 1024)} MB` });
    }

    const order = await merchantOrder(orderId, req.merchantId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const result = await cdnService.generateChatUploadUrl(
      fileName, contentType, fileSize,
      String(req.merchantId), orderId
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Merchant chat upload-url error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to generate upload URL' });
  }
});

router.post('/merchant/chat/:orderId/confirm-upload', merchantAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileKey, cdnUrl, message } = req.body;

    if (!fileKey || !cdnUrl) {
      return res.status(400).json({ success: false, message: 'fileKey and cdnUrl are required' });
    }

    const order = await merchantOrder(orderId, req.merchantId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const verified = await cdnService.verifyUploadedObject({
      fileKey, cdnUrl, expectedUserId: String(req.merchantId), expectedOrderId: orderId, expectedCategory: 'chat'
    });

    const chatMsg = await postMessage({
      orderId:       order.orderId,
      senderId:      String(req.merchantId),
      senderType:    'MERCHANT',
      message:       message || '📎 Attachment',
      attachmentUrl: verified.cdnUrl,
      attachmentKey: verified.fileKey,
      isSystem:      false,
    });

    global.io?.to(`order-${order._id}`).emit('newMessage', chatMsg);

    res.json({ success: true, message: chatMsg });
  } catch (err) {
    console.error('Merchant chat confirm-upload error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to save message' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 📸 PAYMENT PROOF — USER
// User uploads a payment screenshot as a file (not a pasted URL).
// A presigned upload returns fileKey + cdnUrl; later routes must verify the
// object exists before storing the CDN URL. Users cannot submit arbitrary URLs.
// ═══════════════════════════════════════════════════════════════════════

router.post('/user/payment-proof/:orderId/upload-url', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileName, contentType, fileSize } = req.body;

    if (!hasValidUploadInput(fileName, contentType, fileSize)) {
      return res.status(400).json({ success: false, message: 'fileName, contentType, and fileSize are required' });
    }

    // Images only — strict exact MIME match (normalise before compare)
    const PROOF_ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const cleanProofMime = contentType.toLowerCase().split(';')[0].trim();
    if (!PROOF_ALLOWED.includes(cleanProofMime)) {
      return res.status(400).json({ success: false, message: 'Only JPEG, PNG, WebP, and GIF image files are supported' });
    }

    if (fileSize > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'Maximum file size is 10 MB' });
    }

    const order = await playerOrder(orderId, req.user.userId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['ASSIGNED', 'PROCESSING'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot upload proof for order in status ${order.status}` });
    }

    const uploadData = await cdnService.generatePaymentProofUploadUrl(
      fileName, contentType, fileSize,
      req.user.userId.toString(), orderId
    );
    res.json({ success: true, ...uploadData });
  } catch (error) {
    console.error('❌ Payment proof upload URL error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate upload URL' });
  }
});

/**
 * POST /api/user/payment-proof/:orderId/confirm-upload
 * Save the uploaded CDN URL onto the PaymentOrder as proofScreenshot.
 * The object is verified before the CDN URL is stored.
 */
router.post('/user/payment-proof/:orderId/confirm-upload', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileKey, cdnUrl } = req.body;
    if (!fileKey || !cdnUrl) {
      return res.status(400).json({ success: false, message: 'fileKey and cdnUrl are required' });
    }

    const order = await playerOrder(orderId, req.user.userId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const verified = await cdnService.verifyUploadedObject({
      fileKey, cdnUrl, expectedUserId: req.user.userId.toString(), expectedOrderId: orderId, expectedCategory: 'payment-proof'
    });

    // `setOrderFields` refuses an unknown column rather than dropping it. The
    // document model discarded a write to an undeclared path and reported
    // success — a proof screenshot that never saved and a player told it had.
    await db.orders.setOrderFields(order.orderId, { proofScreenshot: verified.cdnUrl });

    res.json({ success: true, message: 'Payment proof saved', proofScreenshot: verified.cdnUrl });
  } catch (error) {
    console.error('❌ Payment proof confirm-upload error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to confirm upload' });
  }
});
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
