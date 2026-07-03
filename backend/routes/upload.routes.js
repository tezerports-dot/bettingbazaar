// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express from 'express';
import mongoose from 'mongoose';
import cdnService from '../services/cdn.service.js';
import { authenticate, isAdmin } from '../domains/identity/auth.middleware.js';
import { merchantAuth } from '../middleware/merchantAuth.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════


// Validates that the requesting user owns the order before issuing

// by the merchant panel and does a participant check).
// ═══════════════════════════════════════════════════════════════════════

router.post('/user/chat/:orderId/upload-url', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileName, contentType, fileSize } = req.body;

    if (!fileName || !contentType || !fileSize) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize are required' });
    }

    const CHAT_ALLOWED = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/webm',
      'application/pdf',
    ];
    const cleanMime = (contentType || '').toLowerCase().split(';')[0].trim();
    if (!CHAT_ALLOWED.includes(cleanMime)) {
      return res.status(400).json({ success: false, message: 'Only JPEG, PNG, WebP, GIF, MP4, MOV, WebM and PDF are allowed' });
    }

    if (fileSize > 20 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'Max file size is 20 MB' });
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

    const chatMsg = await ChatMessage.create({
      orderId:       order._id,
      senderId:      req.user._id,
      senderType:    'USER',
      message:       message || '📎 Attachment',
      attachmentUrl: cdnUrl,
      attachmentKey: fileKey,
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

    if (!fileName || !contentType || !fileSize) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize are required' });
    }

    const CHAT_ALLOWED = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/webm',
      'application/pdf',
    ];
    const cleanMime = (contentType || '').toLowerCase().split(';')[0].trim();
    if (!CHAT_ALLOWED.includes(cleanMime)) {
      return res.status(400).json({ success: false, message: 'Only JPEG, PNG, WebP, GIF, MP4, MOV, WebM and PDF are allowed' });
    }

    if (fileSize > 20 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'Max file size is 20 MB' });
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

    const chatMsg = await ChatMessage.create({
      orderId:       order._id,
      senderId:      req.merchant._id,
      senderType:    'MERCHANT',
      message:       message || '📎 Attachment',
      attachmentUrl: cdnUrl,
      attachmentKey: fileKey,
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
// The CDN URL is returned and stored on the PaymentOrder as proofScreenshot.
// WalletModal uses this when the user taps "Upload Screenshot" instead
// of pasting a link.
// ═══════════════════════════════════════════════════════════════════════

router.post('/user/payment-proof/:orderId/upload-url', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { fileName, contentType, fileSize } = req.body;

    if (!fileName || !contentType || !fileSize) {
      return res.status(400).json({ success: false, message: 'fileName, contentType, and fileSize are required' });
    }

    // Images and PDFs only — strict exact MIME match (normalise before compare)
    const PROOF_ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    const cleanProofMime = (contentType || '').toLowerCase().split(';')[0].trim();
    if (!PROOF_ALLOWED.includes(cleanProofMime)) {
      return res.status(400).json({ success: false, message: 'Only JPEG, PNG, WebP, GIF, and PDF files are supported' });
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
 * Optional — WalletModal can also pass the URL directly in the PAID status update.
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

    order.proofScreenshot = cdnUrl;
    order.updatedAt = new Date();
    await order.save();

    res.json({ success: true, message: 'Payment proof saved', proofScreenshot: cdnUrl });
  } catch (error) {
    console.error('❌ Payment proof confirm-upload error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to confirm upload' });
  }
});

// ── Profile picture & KYC doc upload (used by KYC modal + profile page) ────────
router.post('/user/profile/picture/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType, fileSize } = req.body;
    if (!fileName || !contentType || !fileSize)
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize required' });
    const PIC_ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    const cleanPicMime = (contentType || '').toLowerCase().split(';')[0].trim();
    if (!PIC_ALLOWED.includes(cleanPicMime))
      return res.status(400).json({ success: false, message: 'Only JPG, PNG, WebP, PDF allowed' });
    if (Number(fileSize) > 10 * 1024 * 1024)
      return res.status(400).json({ success: false, message: 'Max file size is 10 MB' });
    const uploadData = await cdnService.generatePresignedUploadUrl({
      fileName, contentType, fileSize: Number(fileSize),
      category: 'kyc', userId: req.user._id.toString()
    });
    res.json({ success: true, ...uploadData });
  } catch (err) {
    // If S3 not configured, tell client to use base64 fallback
    console.error('Profile picture upload-url error:', err.message);
    res.status(503).json({ success: false, message: 'CDN not configured — use direct upload', fallback: true });
  }
});

router.post('/user/profile/picture/confirm-upload', authenticate, async (req, res) => {
  try {
    const { cdnUrl } = req.body;
    if (!cdnUrl) return res.status(400).json({ success: false, message: 'cdnUrl required' });
    const User = mongoose.model('User');
    await User.findByIdAndUpdate(req.user._id, { profilePic: cdnUrl });
    res.json({ success: true, cdnUrl });
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
    if (!fileName || !contentType) return res.status(400).json({ success: false, message: 'fileName and contentType are required' });

    const QR_ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
    const cleanMime  = (contentType || '').toLowerCase().split(';')[0].trim();
    if (!QR_ALLOWED.includes(cleanMime))
      return res.status(400).json({ success: false, message: 'Only JPG, PNG, WebP allowed for QR code images' });
    if (Number(fileSize) > 5 * 1024 * 1024)
      return res.status(400).json({ success: false, message: 'Max file size is 5 MB' });

    const uploadData = await cdnService.generatePresignedUploadUrl({
      fileName, contentType, fileSize: Number(fileSize),
      category: 'merchant-qr', userId: req.merchantId.toString(),
    });
    res.json({ success: true, ...uploadData });
  } catch (err) {
    console.error('Merchant QR upload-url error:', err.message);
    res.status(503).json({ success: false, message: 'CDN not configured — use direct upload', fallback: true });
  }
});

export default router;
