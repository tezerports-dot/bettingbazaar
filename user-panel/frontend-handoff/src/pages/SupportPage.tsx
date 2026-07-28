// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SupportPage.tsx — 2026 "Bazaar" redesign.
 *
 * Admin-configured support channels (GOVERNANCE §1: SupportLinks via
 * backend.getSupportLinks) plus a themed in-app live-chat panel with canned
 * agent replies. Channel data + the FAQ shortcut are unchanged consumers.
 */
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { getBackend } from '../services/backend.service';
import ScreenShell, { card } from '../redesign/Screen';

const backend = getBackend();

interface SupportLinks { whatsapp: string; telegram: string; telegramGroupUrl: string; telegramChannelUrl: string; instagram: string; youtube: string; email: string; }
interface ChatMsg { me: boolean; t: string; who?: string; }

const SupportChat: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [msgs, setMsgs] = useState<ChatMsg[]>([{ me: false, t: 'Hi! Welcome to Betting Bazaar support. How can we help you today?', who: 'Support' }]);
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setMsgs(prev => [...prev, { me: true, t }, { me: false, t: 'Thanks! An agent is looking into this and will reply here shortly.', who: 'Support' }]);
    setText('');
  };
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 130, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(2px)' }} />
      <div className="bb-rise" style={{ position: 'absolute', right: 0, bottom: 0, top: 0, zIndex: 131, width: 'min(94vw,420px)', display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderLeft: '1px solid var(--line2)', boxShadow: '-20px 0 50px -12px rgba(0,0,0,.6)' }}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 11, padding: '16px 16px 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'color-mix(in srgb,var(--gold) 14%,var(--surface3))', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>🛟</span>
          <div style={{ flex: 1, minWidth: 0 }}><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>Live Support</div><div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--green)', fontWeight: 700 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px var(--green)' }} />Agent online · avg reply 2 min</div></div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.me ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '78%' }}>
                {!m.me && <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: 'var(--text3)', margin: '0 0 3px 4px' }}>{m.who}</div>}
                <div style={{ padding: '10px 13px', borderRadius: 14, background: m.me ? 'linear-gradient(135deg,var(--gold2),var(--gold))' : 'var(--surface3)', color: m.me ? '#1a1200' : 'var(--text)', fontSize: 13, lineHeight: 1.45, boxShadow: 'var(--shadow-sm)' }}>{m.t}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ flex: 'none', padding: '12px 14px', borderTop: '1px solid var(--line)', display: 'flex', gap: 9, alignItems: 'center', paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}>
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} placeholder="Type a message…" style={{ flex: 1, height: 44, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 999, padding: '0 16px', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
          <button onClick={send} style={{ width: 44, height: 44, flex: 'none', borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', color: '#1a1200', fontSize: 17 }}>➤</button>
        </div>
      </div>
    </>
  );
};

const SupportPage: React.FC = () => {
  const navigate = useNavigate();
  const [links, setLinks] = useState<SupportLinks | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    (backend as any).getSupportLinks?.()
      .then((data: any) => {
        const d = data?.links ?? data;
        if (d) setLinks({ whatsapp: d.whatsapp || '', telegram: d.telegram || d.telegramUsername || '', telegramGroupUrl: d.telegramGroupUrl || '', telegramChannelUrl: d.telegramChannelUrl || '', instagram: d.instagram || '', youtube: d.youtube || '', email: d.email || '' });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const channels = links ? [
    links.whatsapp && { icon: '💬', label: 'WhatsApp', sub: 'Chat with Support', href: `https://wa.me/${links.whatsapp.replace(/\D/g, '')}`, tag: '9am–11pm', tagBg: 'var(--green)' },
    links.telegram && { icon: '✈️', label: 'Telegram', sub: 'Message support', href: links.telegram.startsWith('http') ? links.telegram : `https://t.me/${links.telegram.replace('@', '')}`, tag: 'Fast', tagBg: 'var(--bombay)' },
    links.telegramGroupUrl && { icon: '👥', label: 'Telegram Group', sub: 'Join the community', href: links.telegramGroupUrl, tag: 'Community', tagBg: 'var(--bombay)' },
    links.telegramChannelUrl && { icon: '📢', label: 'Telegram Channel', sub: 'Announcements', href: links.telegramChannelUrl, tag: 'News', tagBg: 'var(--bombay)' },
    links.instagram && { icon: '📸', label: 'Instagram', sub: 'Follow us', href: links.instagram.startsWith('http') ? links.instagram : `https://instagram.com/${links.instagram.replace('@', '')}`, tag: 'Follow', tagBg: '#E1306C' },
    links.youtube && { icon: '▶️', label: 'YouTube', sub: 'Watch tutorials', href: links.youtube, tag: 'Watch', tagBg: 'var(--red)' },
    links.email && { icon: '📧', label: 'Email', sub: links.email, href: `mailto:${links.email}`, tag: '~24h', tagBg: 'var(--text3)' },
  ].filter(Boolean) as Array<{ icon: string; label: string; sub: string; href: string; tag: string; tagBg: string }> : [];

  return (
    <ScreenShell icon="🛟" title="Support" sub="We are here to help">
      <button onClick={() => setChatOpen(true)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: 16, borderRadius: 16, border: 'none', cursor: 'pointer', textAlign: 'left', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', color: '#1a1200', boxShadow: '0 10px 26px -10px var(--glow)', marginBottom: 14 }}>
        <span style={{ fontSize: 24 }}>💬</span>
        <span style={{ flex: 1 }}><span className="font-grotesk" style={{ display: 'block', fontWeight: 700, fontSize: 16 }}>Start Live Chat</span><span style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: .75 }}>Fastest way to reach us · online now</span></span>
        <span style={{ fontSize: 18 }}>›</span>
      </button>

      {loading && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text3)', fontSize: 12 }}>Loading support contacts…</div>}
      {!loading && channels.length === 0 && (
        <div style={{ ...card, textAlign: 'center', padding: '28px 16px' }}><div style={{ fontSize: 34, marginBottom: 8 }}>📭</div><div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Support contacts not configured</div><div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Please check back later.</div></div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
        {channels.map((c, i) => (
          <a key={i} href={c.href} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 12, ...card, padding: 14, textDecoration: 'none' }}>
            <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 11, background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>{c.icon}</span>
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{c.label}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.sub}</span></span>
            <span style={{ fontSize: 9, fontWeight: 800, padding: '4px 9px', borderRadius: 999, color: '#fff', background: c.tagBg }}>{c.tag}</span>
          </a>
        ))}
      </div>

      <div style={{ ...card, marginTop: 14, textAlign: 'center' }}>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>Support available <b style={{ color: 'var(--text2)' }}>9 AM – 11 PM IST</b>, 7 days a week.</p>
      </div>
      <button onClick={() => navigate('/faq')} style={{ width: '100%', marginTop: 12, background: 'color-mix(in srgb,var(--gold) 10%,transparent)', border: '1px solid var(--line2)', borderRadius: 14, padding: 14, color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>❓ View FAQ / Help Articles</button>

      {chatOpen && <SupportChat onClose={() => setChatOpen(false)} />}
    </ScreenShell>
  );
};

export default SupportPage;
