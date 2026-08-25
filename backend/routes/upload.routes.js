// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express from 'express';
import mongoose from 'mongoose';
import cdnService from '../services/cdn.service.js';
import { authenticate, isAdmin } from '../domains/identity/auth.middleware.js';
import { merchantAuth } from '../middleware/merchantAuth.js';

const router = express.Router();

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

    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You are not the buyer for this order' });
    }

    const result = await cdnService.generateChatUploadUrl(
      fileName, contentType, fileSize,
      req.user._id.toString(), orderId
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

    const PaymentOrder  = mongoose.model('PaymentOrder');
    const ChatMessage = mongoose.model('ChatMessage');

    const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const verified = await cdnService.verifyUploadedObject({
      fileKey, cdnUrl, expectedUserId: req.user._id.toString(), expectedOrderId: orderId, expectedCategory: 'chat'
    });

    const chatMsg = await ChatMessage.create({
      orderId:       order._id,
      senderId:      req.user._id,
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

    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.merchantId?.toString() !== req.merchant._id.toString()) {
      return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
    }

    const result = await cdnService.generateChatUploadUrl(
      fileName, contentType, fileSize,
      req.merchant._id.toString(), orderId
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

    const PaymentOrder  = mongoose.model('PaymentOrder');
    const ChatMessage = mongoose.model('ChatMessage');

    const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.merchantId?.toString() !== req.merchant._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const verified = await cdnService.verifyUploadedObject({
      fileKey, cdnUrl, expectedUserId: req.merchant._id.toString(), expectedOrderId: orderId, expectedCategory: 'chat'
    });

    const chatMsg = await ChatMessage.create({
      orderId:       order._id,
      senderId:      req.merchant._id,
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

    // Verify order belongs to this user
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ orderId }).lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your order' });
    }
    if (!['ASSIGNED', 'PROCESSING'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot upload proof for order in status ${order.status}` });
    }

    const uploadData = await cdnService.generatePaymentProofUploadUrl(
      fileName, contentType, fileSize,
      req.user._id.toString(), orderId
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

    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ orderId });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your order' });
    }

    const verified = await cdnService.verifyUploadedObject({
      fileKey, cdnUrl, expectedUserId: req.user._id.toString(), expectedOrderId: orderId, expectedCategory: 'payment-proof'
    });

    order.proofScreenshot = verified.cdnUrl;
    order.updatedAt = new Date();
    await order.save();

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
// that used to sit on this one; docs/KYC_DOCUMENT_STORAGE.md records them.
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
      category: 'profile', userId: req.user._id.toString()
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
      fileKey, cdnUrl, expectedUserId: req.user._id.toString(), expectedCategory: 'profile'
    });
    const User = mongoose.model('User');
    await User.findByIdAndUpdate(req.user._id, { profilePic: verified.cdnUrl });
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
