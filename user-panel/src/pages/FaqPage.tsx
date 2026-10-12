// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * FaqPage.tsx — 2026 "Bazaar" redesign. Admin-written FAQs (GET /v1/content/faq
 * via backend.getFaq) in a themed accordion, with a static fallback set.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { getBackend } from '../services/backend.service';
import ScreenShell, { card } from '../redesign/Screen';

const backend = getBackend();
interface FAQ { id: string; question: string; answer: string; category: string; }


const FaqPage: React.FC = () => {
  const navigate = useNavigate();
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cat, setCat] = useState('All');

  useEffect(() => {
    (backend as any).getFaq?.().then((d: FAQ[]) => setFaqs(d || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const categories = ['All', ...Array.from(new Set(faqs.map(f => f.category)))];
  // Only what the admin published. How the boards work is the Rules page's,
  // served by the engine's own rules (§2), never a copy kept here.
  const list = cat === 'All' ? faqs : faqs.filter(f => f.category === cat);

  return (
    <ScreenShell icon="❓" title="Help Center" sub="Answers to common questions">
      {faqs.length > 0 && (
        <div className="bb-noscroll" style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 12 }}>
          {categories.map(c => (
            <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c} style={{ flex: 'none', padding: '7px 14px', borderRadius: 999, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', cursor: 'pointer', border: `1px solid ${cat === c ? 'var(--gold)' : 'var(--line)'}`, background: cat === c ? 'var(--gold)' : 'var(--surface)', color: cat === c ? '#1a1200' : 'var(--text2)' }}>{c}</button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><span className="bb-spin" style={{ display: 'inline-block', width: 28, height: 28, border: '2px solid var(--line2)', borderTopColor: 'var(--gold)', borderRadius: '50%' }} /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {list.length === 0 && (
            <div style={{ ...card, textAlign: 'center', padding: 20 }}>
              <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>No help articles yet. How each board works is on the Rules page.</p>
              <button onClick={() => navigate('/rules')} style={{ marginTop: 8, color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13, background: 'none', border: 'none', cursor: 'pointer' }}>Rules &amp; How to Play →</button>
            </div>
          )}
          {list.map(f => {
            const open = openId === f.id;
            return (
              <div key={f.id} style={{ ...card, padding: 0, overflow: 'hidden' }}>
                <button onClick={() => setOpenId(open ? null : f.id)} aria-expanded={open} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: 15, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{f.question}</span>
                  <span style={{ width: 24, height: 24, flex: 'none', borderRadius: 7, background: 'var(--surface3)', border: '1px solid var(--line)', color: 'var(--gold-ink)', fontSize: 15, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{open ? '−' : '+'}</span>
                </button>
                {open && <div style={{ padding: '0 15px 15px', fontSize: 12, lineHeight: 1.6, color: 'var(--text2)' }}>{f.answer}</div>}
              </div>
            );
          })}
          <div style={{ textAlign: 'center', paddingTop: 12 }}>
            <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>Still have questions?</p>
            <button onClick={() => navigate('/support')} style={{ marginTop: 6, color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13, background: 'none', border: 'none', cursor: 'pointer' }}>Contact Support →</button>
          </div>
        </div>
      )}
    </ScreenShell>
  );
};

export default FaqPage;
