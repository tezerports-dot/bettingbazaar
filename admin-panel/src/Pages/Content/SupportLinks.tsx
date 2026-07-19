// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Save, Mail, Phone, MessageCircle, Instagram, Facebook, Twitter, Youtube } from 'lucide-react';
import api from '../../services/api';
import type { SupportLinks as SupportLinksType } from '../../types';
import toast from 'react-hot-toast';

export const SupportLinks: React.FC = () => {
  const [links, setLinks] = useState<SupportLinksType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    email: '',
    phone: '',
    whatsapp: '',
    telegram: '',
    instagram: '',
    facebook: '',
    twitter: '',
    youtube: '',
    supportHours: '',
    responseTime: '',
  });

  useEffect(() => {
    loadLinks();
  }, []);

  const loadLinks = async () => {
    try {
      const response = await api.content.getSupportLinks();
      if (response.success && response.data) {
        setLinks(response.data);
        setFormData({
          email: response.data.email || '',
          phone: response.data.phone || '',
          whatsapp: response.data.whatsapp || '',
          telegram: response.data.telegram || '',
          instagram: response.data.instagram || '',
          facebook: response.data.facebook || '',
          twitter: response.data.twitter || '',
          youtube: response.data.youtube || '',
          supportHours: response.data.supportHours || '',
          responseTime: response.data.responseTime || '',
        });
      }
    } catch (error) {
      toast.error('Failed to load support links');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.content.updateSupportLinks(formData);
      toast.success('Support links updated successfully');
      loadLinks();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update support links');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold mb-2">Support Links & Contact</h1>
        <p className="text-gray-400">Manage support channels and contact information</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Contact Information */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center">
            <Mail className="mr-2" size={20} />
            Contact Information
          </h3>
          <div className="space-y-4">
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="input"
                placeholder="support@bettingbazaar.com"
              />
            </div>
            <div>
              <label className="label">Phone</label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="input"
                placeholder="+91 98765 43210"
              />
            </div>
            <div>
              <label className="label">WhatsApp</label>
              <input
                type="tel"
                value={formData.whatsapp}
                onChange={(e) => setFormData({ ...formData, whatsapp: e.target.value })}
                className="input"
                placeholder="+91 98765 43210"
              />
            </div>
            <div>
              <label className="label">Telegram</label>
              <input
                type="text"
                value={formData.telegram}
                onChange={(e) => setFormData({ ...formData, telegram: e.target.value })}
                className="input"
                placeholder="@bettingbazaar"
              />
            </div>
          </div>
        </div>

        {/* Social Media */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center">
            <Instagram className="mr-2" size={20} />
            Social Media
          </h3>
          <div className="space-y-4">
            <div>
              <label className="label">Instagram</label>
              <input
                type="url"
                value={formData.instagram}
                onChange={(e) => setFormData({ ...formData, instagram: e.target.value })}
                className="input"
                placeholder="https://instagram.com/bettingbazaar"
              />
            </div>
            <div>
              <label className="label">Facebook</label>
              <input
                type="url"
                value={formData.facebook}
                onChange={(e) => setFormData({ ...formData, facebook: e.target.value })}
                className="input"
                placeholder="https://facebook.com/bettingbazaar"
              />
            </div>
            <div>
              <label className="label">Twitter</label>
              <input
                type="url"
                value={formData.twitter}
                onChange={(e) => setFormData({ ...formData, twitter: e.target.value })}
                className="input"
                placeholder="https://twitter.com/bettingbazaar"
              />
            </div>
            <div>
              <label className="label">YouTube</label>
              <input
                type="url"
                value={formData.youtube}
                onChange={(e) => setFormData({ ...formData, youtube: e.target.value })}
                className="input"
                placeholder="https://youtube.com/@bettingbazaar"
              />
            </div>
          </div>
        </div>

        {/* Support Details */}
        <div className="card lg:col-span-2">
          <h3 className="text-lg font-semibold mb-4">Support Details</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Support Hours</label>
              <input
                type="text"
                value={formData.supportHours}
                onChange={(e) => setFormData({ ...formData, supportHours: e.target.value })}
                className="input"
                placeholder="24/7 or 9 AM - 6 PM IST"
              />
            </div>
            <div>
              <label className="label">Average Response Time</label>
              <input
                type="text"
                value={formData.responseTime}
                onChange={(e) => setFormData({ ...formData, responseTime: e.target.value })}
                className="input"
                placeholder="Within 2 hours"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={isSaving}
        className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
      >
        {isSaving ? (
          'Saving...'
        ) : (
          <>
            <Save className="mr-2" size={16} />
            Save Changes
          </>
        )}
      </button>

      {/* ✅ NEW: Active Platforms Preview */}
      <div className="card bg-blue-500/5 border-blue-500/20">
        <h3 className="text-lg font-semibold mb-4">Active Platforms Preview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {formData.email && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <Mail className="mx-auto mb-2 text-blue-500" size={24} />
              <p className="text-sm text-gray-400">Email</p>
              <p className="text-xs text-gray-500 mt-1 truncate">{formData.email}</p>
            </div>
          )}
          {formData.phone && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <Phone className="mx-auto mb-2 text-green-500" size={24} />
              <p className="text-sm text-gray-400">Phone</p>
              <p className="text-xs text-gray-500 mt-1">{formData.phone}</p>
            </div>
          )}
          {formData.whatsapp && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <MessageCircle className="mx-auto mb-2 text-green-500" size={24} />
              <p className="text-sm text-gray-400">WhatsApp</p>
            </div>
          )}
          {formData.telegram && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <MessageCircle className="mx-auto mb-2 text-blue-500" size={24} />
              <p className="text-sm text-gray-400">Telegram</p>
              <p className="text-xs text-gray-500 mt-1">{formData.telegram}</p>
            </div>
          )}
          {formData.instagram && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <Instagram className="mx-auto mb-2 text-pink-500" size={24} />
              <p className="text-sm text-gray-400">Instagram</p>
            </div>
          )}
          {formData.facebook && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <Facebook className="mx-auto mb-2 text-blue-600" size={24} />
              <p className="text-sm text-gray-400">Facebook</p>
            </div>
          )}
          {formData.twitter && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <Twitter className="mx-auto mb-2 text-sky-500" size={24} />
              <p className="text-sm text-gray-400">Twitter</p>
            </div>
          )}
          {formData.youtube && (
            <div className="text-center p-3 bg-dark-700 rounded-lg">
              <Youtube className="mx-auto mb-2 text-red-600" size={24} />
              <p className="text-sm text-gray-400">YouTube</p>
            </div>
          )}
        </div>
        {!formData.email && !formData.phone && !formData.whatsapp && !formData.telegram && 
         !formData.instagram && !formData.facebook && !formData.twitter && !formData.youtube && (
          <p className="text-center text-gray-500 py-4">No platforms configured yet</p>
        )}
      </div>
    </div>
  );
};
