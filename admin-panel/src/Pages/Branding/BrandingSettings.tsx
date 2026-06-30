// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Save, Palette, Eye, RefreshCw, Image as ImageIcon } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

// Image URL preview component
// C-06 fix: CdnUrlField now supports BOTH URL input and file upload.
// GOVERNANCE §12: admin branding page must be a single page for all image assets.
const CdnUrlField: React.FC<{ id: string; name: string; label: string; hint?: string; value: string; onChange: (v: string) => void }> = ({ id, name, label, hint, value, onChange }) => {
  const [error, setError] = useState(false);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/cdn/upload', {
        method: 'POST', body: fd,
        headers: { Authorization: `Bearer ${localStorage.getItem('admin-auth')}` },
      });
      const data = await res.json();
      if (data.url) { onChange(data.url); setError(false); }
      else { alert(data.message || 'Upload failed'); }
    } catch { alert('Upload error'); }
    finally { setUploading(false); e.target.value = ''; }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="label">{label}</label>
      {hint && <p className="text-xs text-gray-400 -mt-1">{hint}</p>}
      <div className="flex gap-2">
        <input id={id} name={name} type="url" value={value}
          onChange={(e) => { onChange(e.target.value); setError(false); }}
          className="input font-mono text-sm flex-1" placeholder="https://cdn.yourdomain.com/..."
        />
        <label className={`btn-secondary text-xs px-3 py-2 cursor-pointer whitespace-nowrap flex-shrink-0${uploading ? ' opacity-50 pointer-events-none' : ''}`}>
          {uploading ? '⏳' : '📎 Upload'}
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
        </label>
      </div>
      {value && !error && (
        <img src={value} alt={label} className="h-12 object-contain rounded border border-dark-600"
          onError={() => setError(true)} />
      )}
      {value && error && (
        <p className="text-xs text-red-400">⚠ Cannot preview this URL — check it's publicly accessible.</p>
      )}
    </div>
  );
}
const BrandingImageInput: React.FC<{
  id: string;
  label: string;
  value: string;
  hint?: string;
  onChange: (url: string) => void;
}> = ({ id, label, value, hint, onChange }) => {
  const [uploading, setUploading] = React.useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/cdn/upload', { method: 'POST', body: fd,
        headers: { Authorization: `Bearer ${localStorage.getItem('admin-auth')}` } });
      const data = await res.json();
      if (data.url) { onChange(data.url); }
      else { alert(data.message || 'Upload failed'); }
    } catch { alert('Upload failed'); }
    finally { setUploading(false); e.target.value = ''; }
  };

  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <div className="flex gap-2 items-start">
        <input
          id={id} name={id} type="url"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="https://... or upload a file →"
          className="input flex-1 text-sm"
        />
        <label className={`btn-secondary text-xs px-3 py-2 cursor-pointer whitespace-nowrap${uploading ? ' opacity-50 pointer-events-none' : ''}`}>
          {uploading ? 'Uploading…' : '📎 Upload'}
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
        </label>
      </div>
      {value && (
        <img src={value} alt={label} className="mt-2 h-12 object-contain rounded border border-dark-600" onError={e => (e.currentTarget.style.display = 'none')} />
      )}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
};


export const BrandingSettings: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('identity');

  const [formData, setFormData] = useState({
    // Identity
    appName: 'Betting Bazaar',
    tagline: 'Bet Smart, Win Big',
    description: '',
    primaryColor: '#D4AF37',
    secondaryColor: '#0ea5e9',
    accentColor: '#F5C77A',
    contactEmail: '',
    contactPhone: '',

    // Core Images (CDN URLs)
    logo: '',
    icon: '',
    favicon: '',
    splashScreen: '',

    // Panel Names
    userPanelName: 'Betting Bazaar',
    adminPanelName: 'Bazaar Admin',
    merchantPanelName: 'Merchant Portal',
    queueManagerPanelName: 'Queue Manager',

    // Promo / Popup Images (CDN URLs)
    homePopupImageUrl: '',
    homePopupLinkUrl: '',
    homePopupEnabled: false,
    tricksTipsBannerUrl: '',
    rulesPageImageUrl: '',
    depositPageBannerUrl: '',
    withdrawalPageBannerUrl: '',
    loginPageBannerUrl: '',
    registerPageBannerUrl: '',

    // Social links removed — managed in SupportLinks page (H-04 / GOVERNANCE §2)
  });

  useEffect(() => { loadBranding(); }, []);

  const loadBranding = async () => {
    try {
      const res = await api.branding.getCurrent();
      if (res.success && res.data) {
        setFormData(prev => ({ ...prev, ...res.data }));
      }
    } catch { toast.error('Failed to load branding'); }
    finally { setIsLoading(false); }
  };

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
    { key: 'images',   label: 'Core Images'        },
    { key: 'promo',    label: 'Promo & Popups'      },
    { key: 'panels',   label: 'Panel Names'          },
  ];

  if (isLoading) return <div className="flex items-center justify-center py-20 text-gray-400">Loading branding settings...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Branding Settings</h1>
          <p className="text-gray-400">Manage platform branding: logos, colours, panel names, and popup/banner images. Social links are in Content → Support Links.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadBranding} className="btn-secondary flex items-center"><RefreshCw size={14} className="mr-1"/>Reload</button>
          <button onClick={handleSave} disabled={isSaving} className="btn-primary flex items-center disabled:opacity-50">
            <Save size={14} className="mr-1"/>{isSaving ? 'Saving...' : 'Save All'}
          </button>
        </div>
      </div>

      {/* CDN Notice */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 text-sm text-gray-300">
        <p><span className="text-blue-400 font-semibold">CDN URLs only</span> — Upload images to your CDN provider, then paste the public URL here. No files are stored on the server (0 RAM usage).</p>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-dark-800 rounded-lg p-1">
        {TABS.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
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
                    <input id={c.id} name={c.name} type="color" value={(formData as any)[c.key]} onChange={(e) => set(c.key, e.target.value)} className="w-12 h-9 rounded border border-dark-600 cursor-pointer bg-transparent" />
                    <input type="text" value={(formData as any)[c.key]} onChange={(e) => set(c.key, e.target.value)} className="input font-mono flex-1" />
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

          {/* H-01: Brand Colours & CDN — previously missing from JSX */}
          <div className="space-y-4">
            <h3 className="font-semibold text-white mb-3">Brand Colours &amp; CDN</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="label" htmlFor="primaryColor">Primary Colour</label>
                <input id="primaryColor" name="primaryColor" type="color"
                  value={formData.primaryColor}
                  onChange={e => set('primaryColor', e.target.value)}
                  className="h-10 w-full rounded border border-gray-600 bg-transparent cursor-pointer" />
                <p className="text-xs text-gray-400 mt-1">e.g. gold accent — sets --brand-primary CSS var</p>
              </div>
              <div>
                <label className="label" htmlFor="secondaryColor">Secondary Colour</label>
                <input id="secondaryColor" name="secondaryColor" type="color"
                  value={formData.secondaryColor}
                  onChange={e => set('secondaryColor', e.target.value)}
                  className="h-10 w-full rounded border border-gray-600 bg-transparent cursor-pointer" />
              </div>
              <div>
                <label className="label" htmlFor="accentColor">Accent Colour</label>
                <input id="accentColor" name="accentColor" type="color"
                  value={formData.accentColor}
                  onChange={e => set('accentColor', e.target.value)}
                  className="h-10 w-full rounded border border-gray-600 bg-transparent cursor-pointer" />
              </div>
            </div>
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

      {/* Core Images */}
      {activeTab === 'images' && (
        <div className="card space-y-6">
          <CdnUrlField id="logo" name="logo" label="Main Logo" hint="Used in all panels top-left. Recommended: PNG with transparency, 200×60px" value={formData.logo} onChange={(v) => set('logo', v)} />
          <CdnUrlField id="icon" name="icon" label="App Icon / Avatar" hint="Square icon used in browser tabs, notifications. Recommended: 512×512px" value={formData.icon} onChange={(v) => set('icon', v)} />
          <CdnUrlField id="favicon" name="favicon" label="Favicon URL" hint="Small browser tab icon. .ico or 32×32px PNG" value={formData.favicon} onChange={(v) => set('favicon', v)} />
          <CdnUrlField id="splash" name="splashScreen" label="Splash Screen / Loading Image" hint="Shown while app loads. Full-width banner." value={formData.splashScreen} onChange={(v) => set('splashScreen', v)} />
        </div>
      )}

      {/* Promo & Popups */}
      {activeTab === 'promo' && (
        <div className="card space-y-6">
          <div className="bg-gold-500/10 border border-gold-500/30 rounded-lg p-3 text-sm text-gray-300">
            These images appear in the user app as banners, popups, and tips. All are CDN URLs — upload to your CDN and paste the URL below.
          </div>

          <div className="space-y-2">
            <CdnUrlField id="home-popup-img" name="homePopupImageUrl" label="Home Page Popup Image" hint="Shown as a modal popup on the home screen" value={formData.homePopupImageUrl} onChange={(v) => set('homePopupImageUrl', v)} />
            <div>
              <label htmlFor="home-popup-link" className="label">Popup Click Link (optional)</label>
              <input id="home-popup-link" name="homePopupLinkUrl" type="url" value={formData.homePopupLinkUrl} onChange={(e) => set('homePopupLinkUrl', e.target.value)} className="input" placeholder="https://... (where popup click goes)" />
            </div>
            <div className="flex items-center gap-3">
              <input id="home-popup-enabled" name="homePopupEnabled" type="checkbox" checked={formData.homePopupEnabled} onChange={(e) => set('homePopupEnabled', e.target.checked)} className="w-4 h-4 rounded" />
              <label htmlFor="home-popup-enabled" className="text-sm">Enable home popup</label>
            </div>
          </div>

          <CdnUrlField id="tricks-banner" name="tricksTipsBannerUrl" label="Tricks & Tips Page Banner" hint="Banner shown at top of tricks/tips page in user app" value={formData.tricksTipsBannerUrl} onChange={(v) => set('tricksTipsBannerUrl', v)} />
          <CdnUrlField id="rules-image" name="rulesPageImageUrl" label="Rules Page Image" hint="Illustration shown on the game rules page" value={formData.rulesPageImageUrl} onChange={(v) => set('rulesPageImageUrl', v)} />
          <CdnUrlField id="deposit-banner" name="depositPageBannerUrl" label="Deposit Page Banner" hint="Promotional banner shown on the deposit/buy tokens page" value={formData.depositPageBannerUrl} onChange={(v) => set('depositPageBannerUrl', v)} />
          <CdnUrlField id="withdrawal-banner" name="withdrawalPageBannerUrl" label="Withdrawal Page Banner" hint="Banner shown on withdraw/sell tokens page" value={formData.withdrawalPageBannerUrl} onChange={(v) => set('withdrawalPageBannerUrl', v)} />
          <CdnUrlField id="login-banner" name="loginPageBannerUrl" label="Login Page Background / Banner" hint="Background or side image on the login screen" value={formData.loginPageBannerUrl} onChange={(v) => set('loginPageBannerUrl', v)} />
          <CdnUrlField id="register-banner" name="registerPageBannerUrl" label="Registration Page Banner" hint="Banner shown on the sign-up screen" value={formData.registerPageBannerUrl} onChange={(v) => set('registerPageBannerUrl', v)} />
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
