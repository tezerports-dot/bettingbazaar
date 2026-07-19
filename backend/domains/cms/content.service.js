// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📝 CONTENT SERVICE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Manages FAQs, support links, and help content
 */

// ✅ FIX #41: Converted from CommonJS (require) to ESM (import) for ES Module project
import mongoose from 'mongoose';

// Lazy model getters to avoid "model not registered" at import time
function FAQ()             { return mongoose.model('FAQ'); }
function SupportLinks()    { return mongoose.model('SupportLinks'); }
function EnhancedAuditLog() { return mongoose.model('EnhancedAuditLog'); }

class ContentService {
  
  /**
   * ════════════════════════════════════════════════════════════════════════════
   * ❓ FAQ MANAGEMENT
   * ════════════════════════════════════════════════════════════════════════════
   */

  /**
   * Get all FAQs
   */
  async getFAQs(category = null, publishedOnly = true) {
    try {
      const query = {};
      if (category) query.category = category;
      if (publishedOnly) query.isPublished = true;

      const faqs = await FAQ().find(query)
        .sort({ category: 1, order: 1, createdAt: -1 });

      return faqs;
    } catch (error) {
      throw new Error(`Failed to get FAQs: ${error.message}`);
    }
  }

  /**
   * Add new FAQ
   */
  async addFAQ(question, answer, category, adminId) {
    try {
      const faq = await FAQ().create({
        question,
        answer,
        category: category || 'general',
        createdBy: adminId,
        isPublished: true
      });

      await EnhancedAuditLog().create({
        performedBy: adminId,
        action: 'FAQ_CREATED',
        category: 'CONTENT',
        targetType: 'FAQ',
        targetId: faq._id.toString(),
        details: { question, category }
      });

      return faq;
    } catch (error) {
      throw new Error(`Failed to add FAQ: ${error.message}`);
    }
  }

  /**
   * Update FAQ
   */
  async updateFAQ(id, question, answer, category, adminId) {
    try {
      const faq = await FAQ().findByIdAndUpdate(
        id,
        { 
          question, 
          answer, 
          category,
          updatedAt: new Date()
        },
        { new: true }
      );

      if (!faq) {
        throw new Error('FAQ not found');
      }

      await EnhancedAuditLog().create({
        performedBy: adminId,
        action: 'FAQ_UPDATED',
        category: 'CONTENT',
        targetType: 'FAQ',
        targetId: id,
        details: { question, category }
      });

      return faq;
    } catch (error) {
      throw new Error(`Failed to update FAQ: ${error.message}`);
    }
  }

  /**
   * Delete FAQ
   */
  async deleteFAQ(id, adminId) {
    try {
      const faq = await FAQ().findByIdAndDelete(id);

      if (!faq) {
        throw new Error('FAQ not found');
      }

      await EnhancedAuditLog().create({
        performedBy: adminId,
        action: 'FAQ_DELETED',
        category: 'CONTENT',
        targetType: 'FAQ',
        targetId: id,
        details: { question: faq.question }
      });

      return { success: true };
    } catch (error) {
      throw new Error(`Failed to delete FAQ: ${error.message}`);
    }
  }

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * 🔗 SUPPORT LINKS MANAGEMENT
   * ════════════════════════════════════════════════════════════════════════════
   */

  /**
   * Get support links
   */
  async getSupportLinks() {
    try {
      let links = await SupportLinks().findOne({ key: 'main' });

      if (!links) {
        // Create default support links
        links = await SupportLinks().create({
          key: 'main',
          supportHours: '24/7',
          responseTime: 'Within 2 hours'
        });
      }

      return links;
    } catch (error) {
      throw new Error(`Failed to get support links: ${error.message}`);
    }
  }

  /**
   * Update support links
   */
  async updateSupportLinks(linksData, adminId) {
    try {
      const links = await SupportLinks().findOneAndUpdate(
        { key: 'main' },
        {
          ...linksData,
          updatedAt: new Date(),
          updatedBy: adminId
        },
        { new: true, upsert: true }
      );

      await EnhancedAuditLog().create({
        performedBy: adminId,
        action: 'SUPPORT_LINKS_UPDATED',
        category: 'CONTENT',
        targetType: 'SupportLinks',
        targetId: links._id.toString(),
        details: linksData
      });

      return links;
    } catch (error) {
      throw new Error(`Failed to update support links: ${error.message}`);
    }
  }
}

// ✅ FIX #41: ESM export default
export default new ContentService();
