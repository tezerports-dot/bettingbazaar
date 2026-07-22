// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * RulesPage.tsx — 2026 "Bazaar" redesign. How to play Delhi vs Bombay Bazaar,
 * plus any admin-published rule slides (location: RULES_PAGE).
 *
 * GOVERNANCE §2/§12: preserves the admin-content consumers — getPublicContent
 * ('RULES_PAGE') and branding.rulesPageImageUrl (rendered as the rules banner).
 */
import React, { useEffect, useState } from 'react';
import { getBackend } from '../services/backend.service';
import { PromoContent } from '../types';
import ScreenShell, { card } from '../redesign/Screen';

const backend = getBackend();

const RULE_BLOCKS = [
  { ic: '🎯', t: 'Pick a side', d: 'Every cycle pits Delhi Bazaar against Bombay Bazaar. Choose a chip value, then tap the side you back.' },
  { ic: '🪙', t: 'Chips & bet amount', d: 'Chips step up 3× (₹10 · 30 · 90 · 270 · 810 for 30-min). Tap a chip then a side to stake it. One side per cycle.' },
  { ic: '⚡', t: 'Pools merge', d: 'A few minutes before results, the pools merge and hide — betting continues blind until bets close.' },
  { ic: '🏆', t: 'Result & payout', d: 'The side with the smaller real-money pool wins. Winners are paid 2× their stake; the timer resets for the next cycle.' },
];

const RulesPage: React.FC = () => {
  const branding = (() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}'); } catch { return {}; } })();
  const rulesBannerUrl: string = branding.rulesPageImageUrl || '';
  const [slides, setSlides] = useState<PromoContent[]>([]);

  useEffect(() => {
    backend.getPublicContent('RULES_PAGE')
      .then(data => setSlides((data || []).filter(s => s.fileUrl)))
      .catch(() => {});
  }, []);

  return (
    <ScreenShell icon="📋" title="How to Play" sub="Rules of Delhi vs Bombay Bazaar">
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        {rulesBannerUrl && <img src={rulesBannerUrl} alt="Rules banner" style={{ width: '100%', borderRadius: 16, marginBottom: 16, border: '1px solid var(--line)' }} />}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {RULE_BLOCKS.map(b => (
            <div key={b.t} style={{ ...card, display: 'flex', alignItems: 'flex-start', gap: 13 }}>
              <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 11, background: 'color-mix(in srgb,var(--gold) 12%,var(--surface3))', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>{b.ic}</span>
              <div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{b.t}</div><div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3, lineHeight: 1.5 }}>{b.d}</div></div>
            </div>
          ))}
        </div>

        {slides.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', margin: '4px 0 12px', fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}><span>🖼️</span><span>Steps published from Admin → RULES_PAGE</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {slides.map((s, i) => (
                <div key={s.id || i} style={{ position: 'relative', width: '100%', aspectRatio: '4 / 5', borderRadius: 18, overflow: 'hidden', border: '1px solid var(--line)', boxShadow: 'var(--shadow-sm)', background: 'var(--surface3)' }}>
                  <img src={s.fileUrl!} alt={s.title || `Step ${i + 1}`} loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                  <div style={{ position: 'absolute', top: 12, left: 12, fontSize: 10, fontWeight: 800, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: 999, padding: '3px 10px', backdropFilter: 'blur(4px)' }}>Step {i + 1} / {slides.length}</div>
                  {(s.title || s.description) && (
                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '40px 16px 16px', background: 'linear-gradient(to top,rgba(0,0,0,.9),rgba(0,0,0,.35),transparent)' }}>
                      {s.title && <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: '#fff' }}>{s.title}</div>}
                      {s.description && <div style={{ fontSize: 12, color: 'rgba(255,255,255,.75)', marginTop: 3 }}>{s.description}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text3)' }}>Fair Play Protected · RNG Certified</div>
      </div>
    </ScreenShell>
  );
};

export default RulesPage;
