// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** content.admin.routes.js — FAQ, support links, promo, announcements */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import contentService from './content.service.js';
import { db } from '#db';

const router = express.Router();

/**
 * The starter FAQ, shipped so a fresh platform's help page is not blank.
 *
 * Ids are fixed rather than generated: `seedFaqs` uses them to make a second
 * concurrent seed a no-op instead of a duplicate set. Editing or deleting any
 * of these is an ordinary admin action and survives — the seed only runs into
 * an empty table.
 */
const STARTER_FAQ = Object.freeze([
  { faqId: 'faq_seed_buy_tokens', category: 'payments',
    question: 'How do I buy tokens?',
    answer: 'Go to Wallet \u2192 Buy Tokens. Choose an amount and follow the P2P deposit flow. A merchant will be assigned to process your payment.' },
  { faqId: 'faq_seed_withdraw', category: 'payments',
    question: 'How do I withdraw winnings?',
    answer: 'Go to Wallet \u2192 Sell Tokens. Enter your bank/UPI details and the amount. Withdrawals are processed within 24 hours.' },
  { faqId: 'faq_seed_delhi_bombay', category: 'gameplay',
    question: 'What is Delhi Bazaar vs Bombay Bazaar?',
    answer: 'It is a prediction game. Pick Delhi or Bombay before the cycle closes. The winning side is determined by the game engine at the end of each round.' },
  { faqId: 'faq_seed_30min', category: 'gameplay',
    question: 'What is a 30-Min cycle?',
    answer: 'A short betting round that completes every 30 minutes. Results appear in the result strip on the home screen.' },
  { faqId: 'faq_seed_fullday', category: 'gameplay',
    question: 'What is the Full-Day (24H) cycle?',
    answer: 'A single round that runs for the entire day. The result is declared at midnight. You can bet throughout the day.' },
  { faqId: 'faq_seed_balances', category: 'account',
    question: 'How is my winnings balance different from deposit balance?',
    answer: 'Deposit balance is used only for placing bets. Winnings balance is fully withdrawable and is credited when you win.' },
  { faqId: 'faq_seed_kyc', category: 'account',
    question: 'How do I complete KYC?',
    answer: 'Go to Profile \u2192 KYC Verification. Upload a valid government ID. Approval usually takes 2\u20134 hours.' },
  { faqId: 'faq_seed_stuck_deposit', category: 'support',
    question: 'What happens if my deposit is stuck?',
    answer: 'Contact support via the Support page. Provide your order ID and payment reference. Issues are resolved within 2 hours.' },
]);

router.get('/content/faq', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    /*
     * The seed used to be a `countDocuments()` followed by an insert, OUTSIDE
     * this try block — so a database that was merely slow to answer took the
     * whole endpoint down with an unhandled rejection rather than a 500, and
     * two admins opening the page together each read zero and each inserted
     * the full set. Both are gone: one statement, guarded by the table being
     * empty, and it runs where a failure is reported.
     */
    await db.content.seedFaqs(STARTER_FAQ);

    const { category, publishedOnly } = req.query;
    // Admin sees ALL FAQs (published and unpublished) by default so drafts are visible
    const showPublishedOnly = publishedOnly === 'true'; // default: show all
    const faqs = await contentService.getFAQs(category || null, showPublishedOnly);

    /*
     * REMOVED (2026-08-26): a "migrate legacy FAQs out of SystemConfig" block
     * that could never run, and would have corrupted data if it had.
     *
     * It read `getSystemConfig()`. `SystemConfig.key` defaults to 'main' and is
     * unique, and nothing in the codebase has ever created a document with any
     * other key \u2014 so the lookup matched nothing, every time, on every admin
     * FAQ page load.
     *
     * The dangerous part was its cleanup. Having inserted the legacy rows it
     * called an unset to clear the source \u2014 but `value` was not a declared
     * path on the config schema, and the ODM's strict mode stripped undeclared
     * paths out of update operators without complaint. The unset was silently
     * discarded. So in the one scenario the block existed for, it would have
     * re-migrated the same legacy FAQs on EVERY request, inserting duplicates
     * forever with nothing reporting a problem.
     *
     * Found by tests/unit/schemaPathWrites.test.js, which is now the standing
     * guard for this bug class.
     */
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
    
    const faq = await contentService.addFAQ(question, answer, category, req.user.userId);
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
    const faq = await contentService.updateFAQ(req.params.faqId, question, answer, category, req.user.userId);
    // 404 rather than reporting success for a row that was never touched.
    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found' });
    res.json({ success: true, message: 'FAQ updated successfully', faq });
  } catch (error) {
    console.error('Update FAQ error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update FAQ' });
  }
});

// Delete FAQ
router.delete('/content/faq/:faqId', authenticate, isAdmin, async (req, res) => {
  try {
    const removed = await contentService.deleteFAQ(req.params.faqId, req.user.userId);
    if (!removed) return res.status(404).json({ success: false, message: 'FAQ not found' });
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
    // The `supportLinks` SCOPE, which is what the public Support page reads.
    // This handler used to read `systemConfig.supportLinks` instead — a second
    // declaration of the same nine fields — so an admin filled in a WhatsApp
    // number here and players saw the field blank. Neither side reported
    // anything; they were simply reading different rows.
    //
    // A scope with nothing set reads as its declared defaults, so the twelve
    // hand-written empty strings that used to be the "no config yet" branch are
    // gone with it.
    res.json({ success: true, supportLinks: await db.config.getConfig('supportLinks') });
  } catch (error) {
    console.error('Get support links error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch support links' });
  }
});

// Update support links
router.put('/content/support-links', authenticate, isAdmin, async (req, res) => {
  try {
    // A PATCH, not a read-modify-write. The old shape read the document,
    // mutated the fields present in the body and saved the whole thing back —
    // so an admin who opened the form, sat on it, and saved silently reverted
    // whatever anybody changed in between. `applyConfig` writes only the keys
    // supplied, in one statement, and versions the change.
    //
    // It also called `new SystemConfig()`, a name deleted with the ODM: on a
    // platform whose config row had not been materialised yet, this handler
    // threw a ReferenceError.
    const { key, version, updatedAt, updatedBy, _id, ...patch } = req.body ?? {};
    for (const field of Object.keys(patch)) {
      if (patch[field] === undefined) delete patch[field];
    }

    const applied = await db.config.applyConfig({
      scope: 'supportLinks', patch,
      actor: req.user.userId, reason: 'Support links updated',
    });

    res.json({
      success: true,
      message: 'Support links updated successfully',
      supportLinks: applied.config,
    });
  } catch (error) {
    // An undeclared key is the admin panel posting a field nobody consumes;
    // the message names it, so it is a 400 the panel can show rather than a
    // 500 the admin has to guess at.
    if (/^config: /.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('Update support links error:', error);
    res.status(500).json({ success: false, message: 'Failed to update support links' });
  }
});

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 🎨 PROMO CONTENT
 *
 * `status` is a three-value vocabulary the table enforces: DRAFT, PUBLISHED,
 * ARCHIVED. The old handlers defaulted it to 'ACTIVE', which no row can hold,
 * and carried a separate `isActive` boolean that could disagree with it. Here
 * ACTIVE is accepted from an older admin build and read as PUBLISHED, and
 * `isActive` is derived from the status rather than stored beside it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

const PROMO_STATUS = { ACTIVE: 'PUBLISHED', PUBLISHED: 'PUBLISHED', DRAFT: 'DRAFT', ARCHIVED: 'ARCHIVED' };
const promoStatus = (value) => PROMO_STATUS[String(value || '').toUpperCase()] ?? null;

router.get('/promo', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { location, status } = req.query;
    const promos = await db.content.listPromos({
      location: location ? String(location).toUpperCase() : null,
      status: status ? promoStatus(status) : null,
    });
    res.json({ success: true, promos });
  } catch (error) {
    console.error('Get promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch promo content' });
  }
});

router.post('/promo', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { title, description, location, mediaType, fileUrl, priority, status } = req.body;
    const resolved = promoStatus(status) ?? 'DRAFT';
    const media = String(mediaType || 'IMAGE').toUpperCase();

    // The table refuses a PUBLISHED promo with nothing to show. Rejecting it
    // here turns that into a 400 the admin panel can display, instead of a 500
    // from a constraint violation.
    if (resolved === 'PUBLISHED' && media !== 'TEXT' && !fileUrl) {
      return res.status(400).json({
        success: false, message: 'A published promo needs a file to show',
      });
    }

    const promo = await db.content.upsertPromo({
      title, description,
      location: String(location || 'HOME').toUpperCase(),
      mediaType: media, fileUrl: fileUrl || null,
      priority: Number(priority) || 0,
      status: resolved, isActive: resolved === 'PUBLISHED',
      createdBy: req.user.userId,
    });
    res.json({ success: true, promo });
  } catch (error) {
    console.error('Create promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to create promo content' });
  }
});

router.put('/promo/:id', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { title, description, location, mediaType, fileUrl, priority, status } = req.body;
    const patch = {};
    if (title !== undefined)       patch.title = String(title);
    if (description !== undefined) patch.description = String(description);
    if (fileUrl !== undefined)     patch.fileUrl = fileUrl || null;
    if (priority !== undefined)    patch.priority = Number(priority) || 0;
    if (location !== undefined)    patch.location = String(location).toUpperCase();
    if (mediaType !== undefined)   patch.mediaType = String(mediaType).toUpperCase();
    if (status !== undefined) {
      const resolved = promoStatus(status);
      if (!resolved) {
        return res.status(400).json({ success: false, message: `Unknown promo status: ${status}` });
      }
      patch.status = resolved;
      patch.isActive = resolved === 'PUBLISHED';
    }

    const promo = await db.content.updatePromo(req.params.id, patch);
    if (!promo) return res.status(404).json({ success: false, message: 'Promo not found' });
    res.json({ success: true, promo });
  } catch (error) {
    console.error('Update promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to update promo content' });
  }
});

router.delete('/promo/:id', authenticate, isAdmin, async (req, res) => {
  try {
    // 404 for an id that was not there: the old handler reported a successful
    // delete whether or not anything existed, so a mistyped id looked done.
    const removed = await db.content.deletePromo(req.params.id);
    if (!removed) return res.status(404).json({ success: false, message: 'Promo not found' });
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
