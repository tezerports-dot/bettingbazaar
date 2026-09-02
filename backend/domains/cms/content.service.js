// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/cms/content.service.js — FAQs.
 *
 * ── What this file lost ─────────────────────────────────────────────────────
 * It also carried `getSupportLinks` and `updateSupportLinks` against a
 * `SupportLinks` model. Nothing called them: support links are keys in the
 * system configuration document and `content.admin.routes.js` reads and writes
 * them there. Two owners for one value is what §1 forbids, and the unused one
 * is the one that goes.
 *
 * Every method was also wrapped in `try { … } catch (e) { throw new Error(...) }`,
 * which discarded the original error's type, code and stack and replaced them
 * with a string. A caller could no longer tell a unique-constraint violation
 * from a lost connection, and the route above answered 500 for both.
 */
import { db } from '#db';

class ContentService {
  /**
   * FAQs, ordered as an editor arranged them.
   *
   * `publishedOnly` defaults to true — the caller has to ASK for unpublished
   * drafts, so a public endpoint that forgets the flag shows nothing rather
   * than everything.
   */
  getFAQs(category = null, publishedOnly = true) {
    return db.content.listFaqs({ category, publishedOnly });
  }

  /** Create an FAQ, published. */
  async addFAQ(question, answer, category, adminId) {
    const faq = await db.content.upsertFaq({
      question, answer, category: category || 'GENERAL',
      isPublished: true, createdBy: adminId,
    });
    await db.audit.recordDetailed({
      performedBy: adminId, action: 'FAQ_CREATED', category: 'CONTENT',
      targetType: 'FAQ', targetId: faq.faqId,
      details: { question: faq.question, faqCategory: faq.category },
    });
    return faq;
  }

  /**
   * Edit an FAQ.
   *
   * Returns null for an id that does not exist, so the route answers 404 rather
   * than reporting success for a row it never touched.
   */
  async updateFAQ(faqId, question, answer, category, adminId) {
    const existing = await db.content.getFaq(faqId);
    if (!existing) return null;

    const faq = await db.content.upsertFaq({
      faqId,
      // An absent field keeps what is stored: an editor fixing a typo in the
      // answer must not blank the question.
      question: question ?? existing.question,
      answer: answer ?? existing.answer,
      category: category ?? existing.category,
      order: existing.order,
      isPublished: existing.isPublished,
      tags: existing.tags,
      createdBy: existing.createdBy,
    });
    await db.audit.recordDetailed({
      performedBy: adminId, action: 'FAQ_UPDATED', category: 'CONTENT',
      targetType: 'FAQ', targetId: faq.faqId, details: { question: faq.question },
    });
    return faq;
  }

  /** Remove an FAQ. False when there was nothing to remove. */
  async deleteFAQ(faqId, adminId) {
    const removed = await db.content.deleteFaq(faqId);
    if (!removed) return false;
    await db.audit.recordDetailed({
      performedBy: adminId, action: 'FAQ_DELETED', category: 'CONTENT',
      targetType: 'FAQ', targetId: String(faqId), details: {},
    });
    return true;
  }
}

export default new ContentService();
