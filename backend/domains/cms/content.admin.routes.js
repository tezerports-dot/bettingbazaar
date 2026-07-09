// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** content.admin.routes.js — FAQ, support links, promo, announcements */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from '../../routes/admin/_adminShared.js';
import contentService from './content.service.js';

const router = express.Router();

router.get('/content/faq', authenticate, isAdminOrSubAdmin, async (req, res) => {
  // Seed default FAQs if collection is empty
  const FAQ = mongoose.model('FAQ');
  const count = await FAQ.countDocuments();
  if (count === 0) {
    const defaults = [
      { question: 'How do I buy tokens?', answer: 'Go to Wallet → Buy Tokens. Choose an amount and follow the P2P deposit flow. A merchant will be assigned to process your payment.', category: 'payments', isPublished: true },
      { question: 'How do I withdraw winnings?', answer: 'Go to Wallet → Sell Tokens. Enter your bank/UPI details and the amount. Withdrawals are processed within 24 hours.', category: 'payments', isPublished: true },
      { question: 'What is Delhi Bazaar vs Bombay Bazaar?', answer: 'It is a prediction game. Pick Delhi or Bombay before the cycle closes. The winning side is determined by the game engine at the end of each round.', category: 'gameplay', isPublished: true },
      { question: 'What is a 30-Min cycle?', answer: 'A short betting round that completes every 30 minutes. Results appear in the result strip on the home screen.', category: 'gameplay', isPublished: true },
      { question: 'What is the Full-Day (24H) cycle?', answer: 'A single round that runs for the entire day. The result is declared at midnight. You can bet throughout the day.', category: 'gameplay', isPublished: true },
      { question: 'How is my winnings balance different from deposit balance?', answer: 'Deposit balance is used only for placing bets. Winnings balance is fully withdrawable and is credited when you win.', category: 'account', isPublished: true },
      { question: 'How do I complete KYC?', answer: 'Go to Profile → KYC Verification. Upload a valid government ID. Approval usually takes 2–4 hours.', category: 'account', isPublished: true },
      { question: 'What happens if my deposit is stuck?', answer: 'Contact support via the Support page. Provide your order ID and payment reference. Issues are resolved within 2 hours.', category: 'support', isPublished: true },
    ];
    await FAQ.insertMany(defaults);
  }
  try {
    const { category, publishedOnly } = req.query;
    // Admin sees ALL FAQs (published and unpublished) by default so drafts are visible
    const showPublishedOnly = publishedOnly === 'true'; // default: show all
    let faqs = await contentService.getFAQs(category || null, showPublishedOnly);

    // Fall back to SystemConfig if FAQ model is empty
    // (FAQs may have been seeded into SystemConfig before the FAQ model existed)
    if (!faqs || faqs.length === 0) {
      const SystemConfig = mongoose.model('SystemConfig');
      const cfg = await SystemConfig.findOne({ key: 'faq' }).lean();
      const legacy = cfg?.value || [];
      if (legacy.length > 0) {
        
        const FAQ = mongoose.model('FAQ');
        const created = await FAQ.insertMany(
          legacy.map((f, i) => ({
            question:    f.question || f.q || '',
            answer:      f.answer   || f.a || '',
            category:    f.category || 'general',
            order:       i,
            isPublished: true,
            createdBy:   req.user._id,
          })),
          { ordered: false }
        );
        // Clear SystemConfig faq key now that they're in the FAQ model
        await SystemConfig.findOneAndUpdate({ key: 'faq' }, { $unset: { value: 1 } });
        faqs = created;
        console.log(`✅ Migrated ${created.length} FAQs from SystemConfig → FAQ model`);
      }
    }

    res.json({ success: true, faqs });
  } catch (error) {
    console.error('Get FAQs error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch FAQs' });
  }
});

// Add FAQ
router.post('/content/faq', authenticate, isAdmin, async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    
    if (!question || !answer) {
      return res.status(400).json({ success: false, message: 'Question and answer are required' });
    }
    
    const faq = await contentService.addFAQ(question, answer, category, req.user._id);
    res.json({ success: true, message: 'FAQ created successfully', faq });
  } catch (error) {
    console.error('Create FAQ error:', error);
    res.status(500).json({ success: false, message: 'Failed to create FAQ' });
  }
});

// Update FAQ
router.put('/content/faq/:faqId', authenticate, isAdmin, async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    const faq = await contentService.updateFAQ(req.params.faqId, question, answer, category, req.user._id);
    res.json({ success: true, message: 'FAQ updated successfully', faq });
  } catch (error) {
    console.error('Update FAQ error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update FAQ' });
  }
});

// Delete FAQ
router.delete('/content/faq/:faqId', authenticate, isAdmin, async (req, res) => {
  try {
    await contentService.deleteFAQ(req.params.faqId, req.user._id);
    res.json({ success: true, message: 'FAQ deleted successfully' });
  } catch (error) {
    console.error('Delete FAQ error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete FAQ' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📝 CONTENT MANAGEMENT - SUPPORT LINKS
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get support links
router.get('/content/support-links', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { SystemConfig } = getModels();
    
    const config = await SystemConfig.findOne();
    if (!config || !config.supportLinks) {
      return res.json({
        success: true,
        supportLinks: {
          whatsapp: '',
          telegram: '',
          telegramUsername: '',
          telegramGroupUrl: '',
          telegramChannelUrl: '',
          email: '',
          helpCenterUrl: '',
          termsUrl: '',
          privacyUrl: ''
        }
      });
    }
    
    res.json({
      success: true,
      supportLinks: config.supportLinks
    });
  } catch (error) {
    console.error('Get support links error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch support links' });
  }
});

// Update support links
router.put('/content/support-links', authenticate, isAdmin, async (req, res) => {
  try {
    const { whatsapp, telegram, telegramUsername, telegramGroupUrl, telegramChannelUrl,
            email, helpCenterUrl, termsUrl, privacyUrl } = req.body;
    const { SystemConfig } = getModels();

    let config = await SystemConfig.findOne();
    if (!config) {
      config = new SystemConfig();
    }

    if (!config.supportLinks) {
      config.supportLinks = {};
    }

    if (whatsapp !== undefined) config.supportLinks.whatsapp = whatsapp;
    if (telegram !== undefined) config.supportLinks.telegram = telegram;
    if (telegramUsername !== undefined) config.supportLinks.telegramUsername = telegramUsername;
    if (telegramGroupUrl !== undefined) config.supportLinks.telegramGroupUrl = telegramGroupUrl;
    if (telegramChannelUrl !== undefined) config.supportLinks.telegramChannelUrl = telegramChannelUrl;
    if (email !== undefined) config.supportLinks.email = email;
    if (helpCenterUrl !== undefined) config.supportLinks.helpCenterUrl = helpCenterUrl;
    if (termsUrl !== undefined) config.supportLinks.termsUrl = termsUrl;
    if (privacyUrl !== undefined) config.supportLinks.privacyUrl = privacyUrl;
    config.markModified('supportLinks');
    
    config.updatedAt = new Date();
    config.updatedBy = req.user._id;
    
    await config.save();
    
    res.json({
      success: true,
      message: 'Support links updated successfully',
      supportLinks: config.supportLinks
    });
  } catch (error) {
    console.error('Update support links error:', error);
    res.status(500).json({ success: false, message: 'Failed to update support links' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🏪 MERCHANT OPERATIONS - ADVANCED
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get merchant details
router.get('/promo', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const PromoContent = mongoose.model('PromoContent');
    const { location, status } = req.query;
    const query = {};
    if (location) query.location = location.toUpperCase();
    if (status)   query.status   = status.toUpperCase();

    const promos = await PromoContent.find(query).sort({ priority: -1, createdAt: -1 }).lean();
    res.json({ success: true, promos });
  } catch (error) {
    console.error('Get promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch promo content' });
  }
});

router.post('/promo', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const PromoContent = mongoose.model('PromoContent');
    const { title, description, location, mediaType, fileUrl, priority, status } = req.body;
    const promo = await PromoContent.create({
      title, description,
      location: location?.toUpperCase(),
      mediaType: mediaType?.toUpperCase() || 'IMAGE',
      fileUrl, priority: priority || 0,
      status: status?.toUpperCase() || 'ACTIVE',
      isActive: (status?.toUpperCase() || 'ACTIVE') === 'ACTIVE',
      createdBy: req.user._id,
      createdAt: new Date()
    });
    res.json({ success: true, promo });
  } catch (error) {
    console.error('Create promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to create promo content' });
  }
});

router.put('/promo/:id', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const PromoContent = mongoose.model('PromoContent');
    const updates = { ...req.body, updatedAt: new Date() };
    if (updates.location) updates.location = updates.location.toUpperCase();
    if (updates.status)   { updates.isActive = updates.status.toUpperCase() === 'ACTIVE'; updates.status = updates.status.toUpperCase(); }
    const promo = await PromoContent.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!promo) return res.status(404).json({ success: false, message: 'Promo not found' });
    res.json({ success: true, promo });
  } catch (error) {
    console.error('Update promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to update promo content' });
  }
});

router.delete('/promo/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const PromoContent = mongoose.model('PromoContent');
    await PromoContent.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Promo deleted' });
  } catch (error) {
    console.error('Delete promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete promo content' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ⚙️ FIX (Audit #25) — SYSTEM CONFIG MANAGEMENT
 * Frontend admin panel calls: GET/PUT /api/admin/system/config
 * ════════════════════════════════════════════════════════════════════════════
 */

export default router;
