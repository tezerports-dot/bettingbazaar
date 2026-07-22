// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * PromoPage.tsx — 2026 "Bazaar" redesign. Pro-tip slides published by admin
 * (location: TRICKS_PAGE) rendered as a themed vertical feed.
 *
 * GOVERNANCE §2/§12: preserves the two admin-content consumers — getPublicContent
 * ('TRICKS_PAGE') and branding.tricksTipsBannerUrl (rendered as the feed banner).
 */
import React, { useEffect, useState } from 'react';
import { getBackend } from '../services/backend.service';
import { PromoContent } from '../types';
import ScreenShell from '../redesign/Screen';

const backend = getBackend();

const PromoPage: React.FC = () => {
  const branding = (() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}'); } catch { return {}; } })();
  const tricksBannerUrl: string = branding.tricksTipsBannerUrl || '';
  const [slides, setSlides] = useState<PromoContent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    backend.getPublicContent('TRICKS_PAGE')
      .then(data => setSlides((data || []).filter(s => s.fileUrl)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <ScreenShell icon="💡" title="Pro Tips" sub="Strategy & tips from the team">
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        {tricksBannerUrl && (
          <img src={tricksBannerUrl} alt="Tips banner" style={{ width: '100%', borderRadius: 16, marginBottom: 16, border: '1px solid var(--line)' }} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', marginBottom: 12, fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>
          <span>🖼️</span><span>Slides published from Admin → TRICKS_PAGE</span>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 30 }}><span className="bb-spin" style={{ display: 'inline-block', width: 28, height: 28, border: '2px solid var(--line2)', borderTopColor: 'var(--gold)', borderRadius: '50%' }} /></div>}

        {!loading && slides.length === 0 && (
          <div style={{ textAlign: 'center', padding: '36px 16px' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🤫</div>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 18, color: 'var(--text)' }}>Classified Intel</div>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, lineHeight: 1.5 }}>Fresh strategies are being prepared by the team. Check back soon.</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 2 }}>
          {slides.map((s, i) => (
            <div key={s.id || i} style={{ position: 'relative', width: '100%', aspectRatio: '4 / 5', borderRadius: 18, overflow: 'hidden', border: '1px solid var(--line)', boxShadow: 'var(--shadow-sm)', background: 'var(--surface3)' }}>
              <img src={s.fileUrl!} alt={s.title || `Tip ${i + 1}`} loading={i === 0 ? 'eager' : 'lazy'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
              <div style={{ position: 'absolute', top: 12, left: 12, fontSize: 10, fontWeight: 800, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: 999, padding: '3px 10px', backdropFilter: 'blur(4px)' }}>{i + 1} / {slides.length}</div>
              {(s.title || s.description) && (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '40px 16px 16px', background: 'linear-gradient(to top,rgba(0,0,0,.9),rgba(0,0,0,.35),transparent)' }}>
                  {s.title && <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: '#fff' }}>{s.title}</div>}
                  {s.description && <div style={{ fontSize: 12, color: 'rgba(255,255,255,.75)', marginTop: 3 }}>{s.description}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
        {!loading && slides.length > 0 && <p style={{ textAlign: 'center', fontSize: 10, color: 'var(--text3)', marginTop: 12 }}>Scroll for more tips · new tips added by the team regularly</p>}
      </div>
    </ScreenShell>
  );
};

export default PromoPage;
