// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Brand mark for the Command Center shell. The player (user) panel renders the
// logo from the backend Branding document (branding.logo, CDN-resolved); this
// component pulls the SAME source so the two panels share one identity, and
// falls back to the design's gold "star" mark when no logo image is set.
// GOVERNANCE §3/§12: brand name, colours and logo originate from Branding only.
import React, { useState } from 'react';

export interface Brand {
  appName: string;
  adminPanelName: string;
  logo?: string;
  primaryColor?: string;
}

/** Read the branding App.tsx caches in localStorage (synced live via SSE). */
export function getBrand(): Brand {
  try {
    const b = JSON.parse(localStorage.getItem('app_branding') || '{}');
    return {
      appName: b.appName || 'Betting Bazaar',
      adminPanelName: b.adminPanelName || 'Command Center',
      logo: typeof b.logo === 'string' ? b.logo : undefined,
      primaryColor: b.primaryColor,
    };
  } catch {
    return { appName: 'Betting Bazaar', adminPanelName: 'Command Center' };
  }
}

/** Only render remote logo images that are absolute URLs (avoids broken paths). */
function resolvedLogo(logo?: string): string | null {
  if (!logo) return null;
  if (/^https?:\/\//i.test(logo) || logo.startsWith('data:')) return logo;
  return null;
}

interface LogoMarkProps {
  size?: number;
  radius?: number;
  /** Try the branding image first; fall back to the star mark. Default true. */
  useBrandingImage?: boolean;
}

/** The square brand mark: branding logo image if available, else gold star. */
export const LogoMark: React.FC<LogoMarkProps> = ({ size = 36, radius = 10, useBrandingImage = true }) => {
  const [failed, setFailed] = useState(false);
  const logo = useBrandingImage ? resolvedLogo(getBrand().logo) : null;

  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt="Logo"
        onError={() => setFailed(true)}
        style={{
          width: size, height: size, flex: 'none',
          borderRadius: radius, objectFit: 'contain',
          background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: size, height: size, flex: 'none', borderRadius: radius,
        background: 'linear-gradient(140deg,var(--gold-ink),var(--gold-deep))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 4px 14px rgba(212,175,55,.32)',
      }}
    >
      <svg width={size * 0.53} height={size * 0.53} viewBox="0 0 24 24" fill="var(--gold-on)">
        <path d="M12 2l2.4 5.9L20.5 9l-4.6 4.1L17.3 20 12 16.7 6.7 20l1.4-6.9L3.5 9l6.1-1.1z" />
      </svg>
    </div>
  );
};

export default LogoMark;
