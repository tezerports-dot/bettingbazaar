// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * useViewport — width/height + responsive breakpoint flags for the redesign.
 * Mirrors the prototype's breakpoints: desktop ≥1000, tablet 680–999, mobile <680.
 */
import { useEffect, useState } from 'react';

export interface Viewport {
  vw: number;
  vh: number;
  desktop: boolean;
  tablet: boolean;
  mobile: boolean;
}

const read = (): Viewport => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  return {
    vw,
    vh,
    desktop: vw >= 1000,
    tablet: vw >= 680 && vw < 1000,
    mobile: vw < 680,
  };
};

export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(read);
  useEffect(() => {
    const onResize = () => setVp(read());
    window.addEventListener('resize', onResize);
    setVp(read());
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}
