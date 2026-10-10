// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useCallback, useEffect, useState } from 'react';
import { Save, Palette, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

type Tab = 'identity' | 'panels';

export const BrandingSettings: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('identity');

  const [formData, setFormData] = useState({
    // Identity
    appName: 'Betting Bazaar',
    tagline: 'Bet Smart, Win Big',
    description: '',
    // Loading placeholders only — line ~216 merges the server's document over
    // these the moment it arrives (§4 permits a placeholder that EQUALS the
    // schema default and cites it). These are
    // `SYSTEM_CONFIG_SPEC.branding` in database/spec/config.spec.js, where the
    // secondary read #0ea5e9 here and #8B5CF6 there while the panel rendered
    // #B8860B — three numbers for one value, which is what §4 forbids.
    primaryColor: '#D4AF37',    // schema default
    secondaryColor: '#B8860B',  // schema default
    accentColor: '#F5C77A',     // schema default
    contactEmail: '',
    contactPhone: '',

    // The CDN every stored image path is resolved against.
    cdnBaseUrl: '',

    // Panel Names
    userPanelName: 'Betting Bazaar',
    adminPanelName: 'Bazaar Admin',
    merchantPanelName: 'Merchant Portal',
    queueManagerPanelName: 'Queue Manager',

    // Every image (logo, icons, board cards, banners) is set on the Images
    // page (Pages/Images), the one place images are edited (owner,
    // 2026-10-10). This page saves only the keys above, so it never writes
    // back an image someone changed there.

    // Social links removed — managed in SupportLinks page (H-04 / GOVERNANCE §2)
  });

  const loadBranding = useCallback(async () => {
    try {
      const res = await api.branding.getCurrent();
      if (res.success && res.data) {
        setFormData(prev => ({ ...prev, ...Object.fromEntries(Object.keys(prev).map(k => [k, res.data[k] ?? (prev as any)[k]])) }));
      }
    } catch { toast.error('Failed to load branding'); }
    finally { setIsLoading(false); }
  }, []);

  useEffect(() => { loadBranding(); }, [loadBranding]);

  const set = (key: string, value: any) => setFormData(prev => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.branding.update(formData);
      toast.success('Branding settings saved');
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to save'); }
    finally { setIsSaving(false); }
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'identity', label: 'Identity & Colors' },
    { key: 'panels',   label: 'Panel Names'          },
  ];

  if (isLoading) return <div className="flex items-center justify-center py-20 text-gray-400">Loading branding settings...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Branding Settings</h1>
          <p className="text-gray-400">Manage platform branding: name, colours and panel names. Every image (logo, icons, promo cards, banners) is on the <a href="#/images" className="underline text-blue-400">Images</a> page. Social links are in Content → Support Links.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadBranding} className="btn-secondary flex items-center"><RefreshCw size={14} className="mr-1"/>Reload</button>
          <button onClick={handleSave} disabled={isSaving} className="btn-primary flex items-center disabled:opacity-50">
            <Save size={14} className="mr-1"/>{isSaving ? 'Saving...' : 'Save All'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-dark-800 rounded-lg p-1">
        {TABS.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} aria-pressed={activeTab === tab.key}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${activeTab === tab.key ? 'bg-dark-600 text-white' : 'text-gray-400 hover:text-white'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Identity & Colors */}
      {activeTab === 'identity' && (
        <div className="card space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="app-name" className="label">App / Platform Name</label>
              <input id="app-name" name="appName" type="text" value={formData.appName} onChange={(e) => set('appName', e.target.value)} className="input" />
            </div>
            <div>
              <label htmlFor="tagline" className="label">Tagline</label>
              <input id="tagline" name="tagline" type="text" value={formData.tagline} onChange={(e) => set('tagline', e.target.value)} className="input" />
            </div>
            <div className="md:col-span-2">
              <label htmlFor="description" className="label">Description</label>
              <textarea id="description" name="description" rows={3} value={formData.description} onChange={(e) => set('description', e.target.value)} className="input" />
            </div>
            <div>
              <label htmlFor="contact-email" className="label">Contact Email</label>
              <input id="contact-email" name="contactEmail" type="email" value={formData.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} className="input" />
            </div>
            <div>
              <label htmlFor="contact-phone" className="label">Contact Phone</label>
              <input id="contact-phone" name="contactPhone" type="tel" value={formData.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} className="input" />
            </div>
          </div>

          <div>
            <h3 className="font-semibold mb-3 flex items-center"><Palette size={16} className="mr-2"/>Brand Colors</h3>
            <div className="grid grid-cols-3 gap-4">
              {[
                { id: 'primary-color', name: 'primaryColor', label: 'Primary (Gold)', key: 'primaryColor' },
                { id: 'secondary-color', name: 'secondaryColor', label: 'Secondary (Blue)', key: 'secondaryColor' },
                { id: 'accent-color', name: 'accentColor', label: 'Accent', key: 'accentColor' },
              ].map((c) => (
                <div key={c.key}>
                  <label htmlFor={c.id} className="label">{c.label}</label>
                  <div className="flex items-center gap-2">
                    <input id={c.id} name={c.name} type="color" value={(formData as any)[c.key]} onChange={(e) => set(c.key, e.target.value)} className="w-12 h-9 rounded-sm border border-dark-600 cursor-pointer bg-transparent" />
                    {/* The swatch beside this carries the label; the hex box
                        carried nothing, so a screen reader read the colour's
                        name and then an anonymous text field. Three of them. */}
                    <input type="text" aria-label={`${c.label} — hex value`}
                      value={(formData as any)[c.key]} onChange={(e) => set(c.key, e.target.value)} className="input font-mono flex-1" />
                  </div>
                </div>
              ))}
            </div>

            {/* Color Preview */}
            <div className="mt-4 p-4 rounded-lg border border-dark-600 bg-dark-800">
              <p className="text-xs text-gray-400 mb-3">Color Preview</p>
              <div className="flex gap-3">
                <div className="px-4 py-2 rounded-lg font-semibold text-sm" style={{ backgroundColor: formData.primaryColor, color: '#1a1a1a' }}>Primary Button</div>
                <div className="px-4 py-2 rounded-lg font-semibold text-sm" style={{ backgroundColor: formData.secondaryColor, color: '#fff' }}>Secondary</div>
                <div className="px-4 py-2 rounded-lg font-semibold text-sm" style={{ backgroundColor: formData.accentColor, color: '#1a1a1a' }}>Accent</div>
              </div>
            </div>
          </div>

          {/* ── CDN only. The three colours used to be repeated here ────────
              This block arrived as "H-01: Brand Colours & CDN" to add the CDN
              field, and brought a SECOND copy of Primary/Secondary/Accent with
              it — so one screen offered six controls for three values, under
              two different names each ("Primary (Gold)" above, "Primary
              Colour" here), both carrying `name="primaryColor"`.

              They wrote the same `formData` keys, so nothing drifted in state.
              What it cost is the operator: two labels for one value on one
              screen, with nothing saying which is authoritative — and §4 has
              already recorded a branding drift that went unnoticed because the
              secondary and accent had no single visible owner. §5 is about
              exactly this shape, and the duplicate is the half to delete. */}
          <div className="space-y-4">
            <h3 className="font-semibold text-white mb-3">CDN</h3>
            <div>
              <label className="label" htmlFor="cdnBaseUrl">CDN Base URL</label>
              <input id="cdnBaseUrl" name="cdnBaseUrl" type="url"
                value={formData.cdnBaseUrl}
                onChange={e => set('cdnBaseUrl', e.target.value)}
                className="input" placeholder="https://cdn.yourdomain.com" />
              <p className="text-xs text-gray-400 mt-1">All logo/image paths are resolved relative to this URL. Leave blank to use absolute URLs.</p>
            </div>
          </div>

          {/* H-01: Panel Names — previously missing from JSX */}
          <div className="space-y-4">
            <h3 className="font-semibold text-white mb-3">Panel Display Names</h3>
            <p className="text-xs text-gray-400">These are shown in browser tabs, sidebar headers, and login screens for each panel.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { id: 'userPanelName', label: 'User Panel Name' },
                { id: 'adminPanelName', label: 'Admin Panel Name' },
                { id: 'merchantPanelName', label: 'Merchant Panel Name' },
                { id: 'queueManagerPanelName', label: 'Queue Manager Panel Name' },
              ].map(({ id, label }) => (
                <div key={id}>
                  <label className="label" htmlFor={id}>{label}</label>
                  <input id={id} name={id} type="text"
                    value={(formData as any)[id]}
                    onChange={e => set(id, e.target.value)}
                    className="input" placeholder={label} />
                </div>
              ))}
            </div>
          </div>

          {/* H-04: Social links removed from Branding — SupportLinks page (/content/support) is the sole authority.
              GOVERNANCE §2: no duplicate write paths for the same value. */}
          <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3">
            <p className="text-sm text-blue-300">
              <strong>Social & Support Links</strong> are managed in{' '}
              <a href="#/content/support" className="underline text-blue-400">Content → Support Links</a>.
              That page is the single authority for WhatsApp, Telegram, Instagram and YouTube links.
            </p>
          </div>
        </div>
      )}

      {/* Panel Names */}
      {activeTab === 'panels' && (
        <div className="card space-y-5">
          <p className="text-sm text-gray-400">Customize the names shown in the header/tab title of each panel.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {[
              { id: 'user-panel-name', name: 'userPanelName', label: 'User App Name', key: 'userPanelName', hint: 'Browser tab title & header in user-facing app' },
              { id: 'admin-panel-name', name: 'adminPanelName', label: 'Admin Panel Name', key: 'adminPanelName', hint: 'Browser tab & header in admin panel' },
              { id: 'merchant-panel-name', name: 'merchantPanelName', label: 'Merchant Panel Name', key: 'merchantPanelName', hint: 'Title shown in merchant portal' },
              { id: 'queue-panel-name', name: 'queueManagerPanelName', label: 'Queue Manager Panel Name', key: 'queueManagerPanelName', hint: 'Title shown for queue manager login' },
            ].map((p) => (
              <div key={p.key}>
                <label htmlFor={p.id} className="label">{p.label}</label>
                <p className="text-xs text-gray-400 mb-1">{p.hint}</p>
                <input id={p.id} name={p.name} type="text" value={(formData as any)[p.key]} onChange={(e) => set(p.key, e.target.value)} className="input" />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={handleSave} disabled={isSaving} className="btn-primary flex items-center disabled:opacity-50">
          <Save size={14} className="mr-2"/>{isSaving ? 'Saving...' : 'Save Branding Settings'}
        </button>
      </div>
    </div>
  );
};
