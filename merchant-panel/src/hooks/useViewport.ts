// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Viewport size class. The design specifies three shells — mobile (bottom nav),
// tablet (icon rail) and desktop (labelled sidebar) — and several screens change
// their grid, not just their width, between them. The breakpoints below are the
// device widths the prototype was drawn at.
//
// GOVERNANCE §10: UI-only values. Nothing here is used for server-side
// validation or business logic.
import { useEffect, useState } from 'react';

export type Viewport = 'mobile' | 'tablet' | 'desktop';

const TABLET_MIN = 768;   // prototype tablet frame: 834px
const DESKTOP_MIN = 1100; // prototype desktop frame: 1280px

function classify(width: number): Viewport {
  if (width >= DESKTOP_MIN) return 'desktop';
  if (width >= TABLET_MIN) return 'tablet';
  return 'mobile';
}

export function useViewport(): { viewport: Viewport; isMobile: boolean; isTablet: boolean; isDesktop: boolean } {
  const [viewport, setViewport] = useState<Viewport>(() =>
    classify(typeof window === 'undefined' ? DESKTOP_MIN : window.innerWidth)
  );

  useEffect(() => {
    const onResize = () => setViewport(classify(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return {
    viewport,
    isMobile: viewport === 'mobile',
    isTablet: viewport === 'tablet',
    isDesktop: viewport === 'desktop',
  };
}
