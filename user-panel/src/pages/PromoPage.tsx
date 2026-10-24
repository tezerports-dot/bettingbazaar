// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * PromoPage.tsx — Pro Tips as full-screen reels (owner, 2026-10-24: "assume
 * it as insta full screen size reels scrolling"). Each slide the admin
 * published to TRICKS_PAGE fills the space between the header and the bottom
 * bar, one per swipe, in the admin's order (priority, then newest). A video
 * plays by itself, muted and looped, only while it is on screen; a tap turns
 * the sound on or off.
 *
 * GOVERNANCE §2/§12: the two admin-content consumers — getPublicContent
 * ('TRICKS_PAGE') and branding.tricksTipsBannerUrl (the first reel, shown
 * whole, since it is a wide banner rather than a portrait reel).
 */
import React, { useEffect, useRef, useState } from 'react';
import { getBackend } from '../services/backend.service';
import { PromoContent } from '../types';
import { useBranding } from '../services/branding';
import { useViewport } from '../redesign/useViewport';

const backend = getBackend();

interface Reel { key: string; url: string; video: boolean; fit: 'cover' | 'contain'; title?: string; description?: string }

/** A reel's video: plays while at least 60% of it is on screen, paused otherwise. */
const ReelVideo: React.FC<{ url: string; label: string; muted: boolean }> = ({ url, label, muted }) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => { /* the browser refused autoplay; a tap plays it */ });
      else video.pause();
    }, { threshold: 0.6 });
    observer.observe(video);
    return () => observer.disconnect();
  }, []);
  return (
    <video ref={ref} src={url} aria-label={label} muted={muted} loop playsInline preload="metadata"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
  );
};

const PromoPage: React.FC = () => {
  const branding = useBranding();
  const tricksBannerUrl = String(branding.tricksTipsBannerUrl || '');
  const { mobile } = useViewport();
  const [slides, setSlides] = useState<PromoContent[]>([]);
  const [loading, setLoading] = useState(true);
  // One switch for every reel, as on Instagram: sound on stays on as you swipe.
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    backend.getPublicContent('TRICKS_PAGE')
      .then(data => setSlides((data || []).filter(s => s.fileUrl)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const reels: Reel[] = [
    ...(tricksBannerUrl ? [{ key: 'banner', url: tricksBannerUrl, video: false, fit: 'contain' as const }] : []),
    ...slides.map((s, i) => ({
      key: String((s as PromoContent & { promoId?: string }).promoId || s.id || i),
      url: s.fileUrl, video: s.mediaType === 'VIDEO', fit: 'cover' as const,
      title: s.title || undefined, description: s.description || undefined,
    })),
  ];

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-busy="true">
        <span className="bb-spin" style={{ display: 'inline-block', width: 28, height: 28, border: '2px solid var(--line2)', borderTopColor: 'var(--gold)', borderRadius: '50%' }} />
      </div>
    );
  }

  if (reels.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '36px 16px' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🤫</div>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 18, color: 'var(--text)' }}>Pro Tips are on the way</div>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, lineHeight: 1.5 }}>Fresh strategies are being prepared by the team. Check back soon.</p>
      </div>
    );
  }

  return (
    <section aria-label="Pro Tips" className="bb-noscroll" style={{
      flex: 1, minHeight: 0, overflowY: 'auto', scrollSnapType: 'y mandatory', overscrollBehavior: 'contain', background: '#000',
    }}>
      {reels.map((r, i) => (
        <article key={r.key} aria-label={r.title || `Tip ${i + 1} of ${reels.length}`} style={{
          position: 'relative', height: '100%', scrollSnapAlign: 'start', scrollSnapStop: 'always',
          // A tablet or laptop shows the reel at a phone's shape in the middle, as Instagram does.
          width: mobile ? '100%' : 'min(100%, 480px)', margin: '0 auto', overflow: 'hidden', background: '#000',
        }}>
          {r.video ? (
            <>
              <ReelVideo url={r.url} label={r.title || `Tip ${i + 1}`} muted={muted} />
              <button type="button" onClick={() => setMuted(m => !m)} aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <span aria-hidden="true" style={{ position: 'absolute', right: 12, bottom: r.title || r.description ? 92 : 16, width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,0,0,.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>
                  {muted ? '🔇' : '🔊'}
                </span>
              </button>
            </>
          ) : (
            <img src={r.url} alt={r.title || `Tip ${i + 1}`} loading={i < 2 ? 'eager' : 'lazy'}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: r.fit }} />
          )}
          <div style={{ position: 'absolute', top: 12, right: 12, fontSize: 10, fontWeight: 800, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: 999, padding: '3px 10px', pointerEvents: 'none' }}>
            {i + 1} / {reels.length}
          </div>
          {(r.title || r.description) && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '48px 16px 18px', background: 'linear-gradient(to top,rgba(0,0,0,.9),rgba(0,0,0,.35),transparent)', pointerEvents: 'none' }}>
              {r.title && <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: '#fff' }}>{r.title}</div>}
              {r.description && <div style={{ fontSize: 12, color: 'rgba(255,255,255,.8)', marginTop: 3 }}>{r.description}</div>}
            </div>
          )}
          {i === 0 && reels.length > 1 && (
            <div aria-hidden="true" style={{ position: 'absolute', left: '50%', bottom: r.title || r.description ? 84 : 14, transform: 'translateX(-50%)', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,.75)', background: 'rgba(0,0,0,.45)', borderRadius: 999, padding: '3px 10px', pointerEvents: 'none' }}>
              Swipe up for more
            </div>
          )}
        </article>
      ))}
    </section>
  );
};

export default PromoPage;
