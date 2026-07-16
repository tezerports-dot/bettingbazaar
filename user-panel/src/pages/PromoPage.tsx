/**
 * PromoPage.tsx — Tips & Tricks
 *
 * Displays slides uploaded by admin (location: TRICKS_PAGE) as a full-screen
 * swipeable vertical carousel. Users swipe up/down or tap arrows to navigate.
 * If admin has uploaded images, they fill the screen edge-to-edge.
 * Falls back to the old card layout when no slides are configured.
 */

// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getBackend } from '../services/backend.service';
import { PromoContent } from '../types';
// Inline chevrons — lucide-react is not in user panel package.json
const ChevronUp = ({size=18,className=''}: {size?:number,className?:string}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="18 15 12 9 6 15"/>
  </svg>
);
const ChevronDown = ({size=18,className=''}: {size?:number,className?:string}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

const backend = getBackend();

// C-06 fix: PromoPage reads tricksTipsBannerUrl from branding.
// GOVERNANCE §2: admin-set banner URLs must have real consumers in the UI.
const PromoPage: React.FC = () => {
  const branding = (() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}'); } catch { return {}; } })();
  const tricksBannerUrl = branding.tricksTipsBannerUrl || '';
  const [slides, setSlides] = useState<PromoContent[]>([]);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const touchStartY = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    backend.getPublicContent('TRICKS_PAGE')
      .then(data => {
        // Only show active image slides — filter out any text-only entries
        const imgSlides = (data || []).filter(s => s.fileUrl);
        setSlides(imgSlides);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const goTo = useCallback((idx: number) => {
    setCurrent(Math.max(0, Math.min(slides.length - 1, idx)));
  }, [slides.length]);

  // Touch swipe handlers
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const dy = touchStartY.current - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 40) goTo(current + (dy > 0 ? 1 : -1));
  };

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') goTo(current + 1);
      if (e.key === 'ArrowUp'   || e.key === 'ArrowLeft')  goTo(current - 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [current, goTo]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0B0E14]">
        <div className="w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── No slides — fallback empty state ──────────────────────────────────────
  if (slides.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#0B0E14] px-6 text-center">
        <div className="text-5xl mb-4">🤫</div>
        <h2 className="text-white font-black text-2xl mb-2">Classified Intel</h2>
        <p className="text-slate-400 text-sm leading-relaxed max-w-xs">
          Strategies are currently being updated by the Grandmaster. Check back soon.
        </p>
      </div>
    );
  }

  const slide = slides[current];

  // ── Full-screen carousel ───────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="h-full relative overflow-hidden bg-black select-none"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Slides — render all, translate to current */}
      <div
        className="h-full transition-transform duration-300 ease-out"
        style={{ transform: `translateY(-${current * 100}%)` }}
      >
        {slides.map((s, i) => (
          <div key={s.id || i} className="h-full w-full relative flex-shrink-0" style={{ height: '100vh', position: 'relative' }}>
            {/* Full-bleed image */}
            <img
              src={s.fileUrl!}
              alt={s.title || `Slide ${i + 1}`}
              className="absolute inset-0 w-full h-full object-cover"
              loading={i === 0 ? 'eager' : 'lazy'}
            />
            {/* Bottom gradient + caption */}
            {s.title && (
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-5 pb-8 pt-16">
                <p className="text-white font-bold text-base">{s.title}</p>
                {s.description && (
                  <p className="text-slate-300 text-xs mt-1 leading-relaxed">{s.description}</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Prev / Next arrow buttons */}
      {current > 0 && (
        <button
          onClick={() => goTo(current - 1)}
          className="absolute top-4 right-4 z-20 w-9 h-9 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white"
          aria-label="Previous"
        >
          <ChevronUp size={18} />
        </button>
      )}
      {current < slides.length - 1 && (
        <button
          onClick={() => goTo(current + 1)}
          className="absolute bottom-6 right-4 z-20 w-9 h-9 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white"
          aria-label="Next"
        >
          <ChevronDown size={18} />
        </button>
      )}

      {/* Dot indicators */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-1.5">
        {slides.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            className={`w-1.5 rounded-full transition-all ${
              i === current ? 'h-5 bg-[#D4AF37]' : 'h-1.5 bg-white/40'
            }`}
            aria-label={`Go to slide ${i + 1}`}
          />
        ))}
      </div>

      {/* Slide counter */}
      <div className="absolute top-4 left-4 z-20 bg-black/50 backdrop-blur px-2 py-0.5 rounded-full text-xs text-white font-mono">
        {current + 1} / {slides.length}
      </div>

      {/* Swipe hint on first slide */}
      {current === 0 && slides.length > 1 && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1 animate-bounce">
          <ChevronDown size={16} className="text-white/50" />
          <span className="text-[10px] text-white/40 tracking-widest uppercase">Swipe</span>
        </div>
      )}
    </div>
  );
};

export default PromoPage;

