// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { HelpCircle, Plus, Edit, Trash2, Eye, EyeOff } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { Kpis, Toolbar } from '../../components/design';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import api from '../../services/api';
import type { FAQ } from '../../types';
import toast from 'react-hot-toast';

export const FAQManager: React.FC = () => {
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingFaq, setEditingFaq] = useState<FAQ | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FAQ | null>(null);

  const [formData, setFormData] = useState({
    question: '',
    answer: '',
    category: 'general' as FAQ['category'],
    isPublished: true,
  });

  useEffect(() => {
    loadFAQs();
  }, []);

  const loadFAQs = async () => {
    setIsLoading(true);
    try {
      const response = await api.content.getAllFAQs();
      if (response.success && response.data) {
        setFaqs(response.data);
      }
    } catch (error) {
      toast.error('Failed to load FAQs');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingFaq) {
        await api.content.updateFAQ(editingFaq._id, formData);
        toast.success('FAQ updated');
      } else {
        await api.content.createFAQ(formData);
        toast.success('FAQ created');
      }
      setShowModal(false);
      loadFAQs();
      resetForm();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to save FAQ');
    }
  };

  const handleDelete = async (faqId: string) => {
    try {
      await api.content.deleteFAQ(faqId);
      toast.success('FAQ deleted');
      loadFAQs();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to delete FAQ');
    }
  };

  const resetForm = () => {
    setFormData({
      question: '',
      answer: '',
      category: 'general',
      isPublished: true,
    });
    setEditingFaq(null);
  };

  const columns = [
    {
      key: 'question',
      label: 'Question',
      render: (faq: FAQ) => <p className="font-medium">{faq.question}</p>,
    },
    {
      key: 'category',
      label: 'Category',
      render: (faq: FAQ) => (
        <span className="px-2 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-500">
          {faq.category}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (faq: FAQ) =>
        faq.isPublished ? (
          <span className="text-green-500 flex items-center text-sm">
            <Eye size={14} className="mr-1" /> Published
          </span>
        ) : (
          <span className="text-gray-500 flex items-center text-sm">
            <EyeOff size={14} className="mr-1" /> Draft
          </span>
        ),
    },
    {
      key: 'views',
      label: 'Views',
      render: (faq: FAQ) => <span className="text-sm text-gray-400">{faq.views || 0}</span>,
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (faq: FAQ) => (
        <div className="flex items-center space-x-2">
          <button
            onClick={() => {
              setEditingFaq(faq);
              setFormData({
                question: faq.question,
                answer: faq.answer,
                category: faq.category,
                isPublished: faq.isPublished,
              });
              setShowModal(true);
            }}
            className="p-2 hover:bg-dark-700 rounded-lg transition-colors"
          >
            <Edit size={16} />
          </button>
          <button
            onClick={() => setConfirmDelete(faq)}
            className="p-2 hover:bg-red-600/20 rounded-lg transition-colors text-red-500"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="om-fade">
      <Kpis min={200} items={[
        { label: 'Total FAQs', value: faqs.length },
        { label: 'Published', value: faqs.filter((f) => f.isPublished).length, tone: 'var(--success)' },
        { label: 'Total Views', value: faqs.reduce((sum, f) => sum + (f.views || 0), 0), tone: 'var(--info)' },
      ]} />
      <Toolbar actions={[{ label: 'Add FAQ', icon: Plus, primary: true, onClick: () => { resetForm(); setShowModal(true); } }]} />

      {/* Table */}
      <div className="card">
        <DataTable
          data={faqs}
          columns={columns}
          currentPage={1}
          totalPages={1}
          onPageChange={() => {}}
          isLoading={isLoading}
        />
      </div>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false);
          resetForm();
        }}
        title={editingFaq ? 'Edit FAQ' : 'Create FAQ'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Question</label>
            <input
              type="text"
              value={formData.question}
              onChange={(e) => setFormData({ ...formData, question: e.target.value })}
              className="input"
              required
            />
          </div>

          <div>
            <label className="label">Answer</label>
            <textarea
              value={formData.answer}
              onChange={(e) => setFormData({ ...formData, answer: e.target.value })}
              className="input min-h-[150px]"
              required
            />
          </div>

          <div>
            <label className="label">Category</label>
            <select
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value as FAQ['category'] })}
              className="input"
            >
              <option value="general">General</option>
              <option value="account">Account</option>
              <option value="betting">Betting</option>
              <option value="payments">Payments</option>
              <option value="kyc">KYC</option>
              <option value="security">Security</option>
              <option value="technical">Technical</option>
            </select>
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="isPublished"
              checked={formData.isPublished}
              onChange={(e) => setFormData({ ...formData, isPublished: e.target.checked })}
              className="w-4 h-4"
            />
            <label htmlFor="isPublished" className="text-sm">
              Publish immediately
            </label>
          </div>

          <button type="submit" className="w-full btn-primary">
            {editingFaq ? 'Update FAQ' : 'Create FAQ'}
          </button>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      {confirmDelete && (
        <ConfirmDialog
          isOpen={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete._id)}
          title="Delete FAQ"
          message={`Delete "${confirmDelete.question}"?`}
          type="danger"
        />
      )}
    </div>
  );
};
