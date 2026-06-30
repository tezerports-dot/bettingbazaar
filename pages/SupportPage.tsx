// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SupportPage.tsx  v4.3.0 — NEW PAGE
 * BUG-U19 FIX: Displays admin-configured support channels (WhatsApp, Telegram,
 * Instagram, YouTube, email) from GET /v1/content/support-links.
 * Previously there was no way to contact support from within the app.
 */
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBackend } from '../services/backend.service';

const backend = getBackend();

interface SupportLinks {
  whatsapp:  string;
  telegram:  string;
  instagram: string;
  youtube:   string;
  email:     string;
}

const SupportPage: React.FC = () => {
  const navigate = useNavigate();
  const [links, setLinks]   = useState<SupportLinks | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // FIX-8: getSupportLinks returns { links: {...} } — unwrap correctly
    (backend as any).getSupportLinks?.()
      .then((data: any) => {
        const d = data?.links ?? data;
        if (d) setLinks({ whatsapp: d.whatsapp||'', telegram: d.telegram||'', instagram: d.instagram||'', youtube: d.youtube||'', email: d.email||'' });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const channels = links
    ? [
        links.whatsapp  && { icon: '💬', label: 'WhatsApp',  sub: 'Chat with Support', href: `https://wa.me/${links.whatsapp.replace(/\D/g, '')}`, color: '#25D366' },
        links.telegram  && { icon: '✈️',  label: 'Telegram',  sub: 'Join our channel',  href: links.telegram.startsWith('http') ? links.telegram : `https://t.me/${links.telegram.replace('@', '')}`, color: '#2AABEE' },
        links.instagram && { icon: '📸', label: 'Instagram', sub: 'Follow us',          href: links.instagram.startsWith('http') ? links.instagram : `https://instagram.com/${links.instagram.replace('@', '')}`, color: '#E1306C' },
        links.youtube   && { icon: '▶️',  label: 'YouTube',   sub: 'Watch tutorials',   href: links.youtube, color: '#FF0000' },
        links.email     && { icon: '📧', label: 'Email',     sub: links.email,          href: `mailto:${links.email}`, color: '#D4AF37' },
      ].filter(Boolean)
    : [];

  return (
    <div className="h-full flex flex-col bg-[#0B0E14]">

      <div className="flex-1 overflow-y-auto pb-4 p-5">

        <div className="bg-[#121826] rounded-2xl border border-[#D4AF37]/20 p-6 mb-6 text-center">
          <div className="text-5xl mb-3">🤝</div>
          <h2 className="text-xl font-black text-white mb-2">We're Here to Help</h2>
          <p className="text-slate-400 text-sm leading-relaxed">
            Contact us through any of the channels below. Our support team typically responds within a few hours.
          </p>
        </div>

        {loading ? (
          <div className="flex flex-col items-center py-12 gap-4">
            <div className="w-10 h-10 border-4 border-[#D4AF37]/20 border-t-[#D4AF37] rounded-full animate-spin" />
            <p className="text-slate-500 text-xs">Loading support contacts…</p>
          </div>
        ) : channels.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-4">📭</div>
            <h3 className="text-white font-bold mb-2">Support Contacts Not Configured</h3>
            <p className="text-slate-400 text-sm">Please check back later or ask the admin to configure support links.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {channels.map((ch: any, i: number) => (
              <a
                key={i}
                href={ch.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-[#1A1F2E] rounded-2xl p-5 border border-white/5 hover:border-[#D4AF37]/30 active:scale-[0.98] transition-all group"
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl flex-shrink-0"
                    style={{ backgroundColor: `${ch.color}20`, border: `1px solid ${ch.color}40` }}
                  >
                    {ch.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-bold">{ch.label}</div>
                    <div className="text-slate-500 text-xs truncate">{ch.sub}</div>
                  </div>
                  <span className="text-[#D4AF37] group-hover:translate-x-1 transition-transform">›</span>
                </div>
              </a>
            ))}
          </div>
        )}

        {/* Business hours note */}
        <div className="mt-6 bg-[#121826] rounded-2xl border border-white/5 p-4 text-center">
          <p className="text-slate-500 text-xs">
            Support available <span className="text-slate-300 font-bold">9 AM – 11 PM IST</span>, 7 days a week.
          </p>
        </div>

        {/* FAQ shortcut */}
        <button
          onClick={() => navigate('/faq')}
          className="mt-3 w-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded-2xl p-4 text-[#D4AF37] font-bold text-sm hover:bg-[#D4AF37]/20 transition-all"
        >
          ❓ View FAQ / Help Articles
        </button>
      </div>

    </div>
  );
};

export default SupportPage;
