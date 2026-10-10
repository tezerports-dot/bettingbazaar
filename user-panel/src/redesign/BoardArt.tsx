// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The board's side-column artwork and promo cards (owner, 2026-10-10: "fill
 * them up with proper illustration or graphic designs as the stake do").
 *
 *   • `PromoCard`   — one published HOME card (Admin › Page Slides), opening
 *                      its own link: an app page in place, https in a new tab
 *   • `CitiesArt`   — Delhi's India Gate against Bombay's Gateway of India
 *   • `HowToPlayArt`— chip, tap, trophy: the three moves of a round
 *
 * The art is drawn, not uploaded, in the theme's own colours (`--delhi`,
 * `--bombay`, `--gold`), so it follows the branding and both themes. Every
 * claim on it is one the board already makes (the Payout card's rule).
 */
import React from 'react';
import { getAssetUrl } from '../services/backend.service';

// ── Promo card ───────────────────────────────────────────────────────────────
export interface HomeCard {
  promoId?: string;
  id?: string;
  title?: string;
  fileUrl?: string;
  /** An app page ('/referrals') or an https link; the server's `promoLinkUrl` rule. */
  linkUrl?: string | null;
}

/** Where a tap goes: `#/page` in place, https in a new tab, or nowhere. */
export function cardHref(linkUrl?: string | null): { href: string; external: boolean } | null {
  const raw = String(linkUrl ?? '').trim();
  if (/^\/[A-Za-z0-9/_-]*$/.test(raw)) return { href: `#${raw}`, external: false };
  if (/^https:\/\/\S+$/.test(raw)) return { href: raw, external: true };
  return null;
}

/** `whole`: the image at its own proportions, never cropped (the phone carousel). */
export const PromoCard: React.FC<{ card: HomeCard; whole?: boolean }> = ({ card, whole }) => {
  const link = cardHref(card.linkUrl);
  const label = card.title || 'Promotion';
  const body = (
    <>
      <img src={getAssetUrl(card.fileUrl || '')} alt={label} loading="lazy" style={whole
        ? { display: 'block', width: '100%', height: 'auto' }
        : { display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'cover' }} />
      <span style={{ position: 'absolute', top: 8, left: 8, padding: '2px 8px', borderRadius: 999, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }}>{label}</span>
    </>
  );
  const frame: React.CSSProperties = { position: 'relative', display: 'block', borderRadius: 16, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface)', flex: 'none' };
  if (!link) return <div style={frame}>{body}</div>;
  return (
    <a href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} aria-label={label} style={{ ...frame, cursor: 'pointer' }}>
      {body}
    </a>
  );
};

// ── Shared art frame ─────────────────────────────────────────────────────────
/** The art at its own proportions, never stretched or cropped. */
const ArtFrame: React.FC<{ children: React.ReactNode; title: string; sub: string; label: string; backdrop: string; align: 'end' | 'center' }> = ({ children, title, sub, label, backdrop, align }) => (
  <figure aria-label={label} style={{ margin: 0, flex: 'none', position: 'relative', borderRadius: 16, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: align === 'end' ? 'flex-end' : 'center', background: backdrop }}>{children}</div>
    <figcaption style={{ padding: '12px 16px 14px', borderTop: '1px solid var(--line)' }}>
      <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3, lineHeight: 1.45 }}>{sub}</div>
    </figcaption>
  </figure>
);

const svgFill: React.CSSProperties = { display: 'block', width: '100%', height: 'auto' };

// ── Delhi vs Bombay ──────────────────────────────────────────────────────────
export const CitiesArt: React.FC = () => (
  <ArtFrame label="Delhi's India Gate and Bombay's Gateway of India" title="Two cities. One winner." sub="Back Delhi or Bombay. The side with fewer real bets wins 2×." align="end"
    backdrop="linear-gradient(90deg, color-mix(in srgb, var(--delhi) 22%, transparent) 50%, color-mix(in srgb, var(--bombay) 22%, transparent) 50%)">
    <svg viewBox="0 0 300 200" style={svgFill} aria-hidden="true">
      <defs>
        <linearGradient id="bbArtSkyD" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--delhi)', stopOpacity: 0.42 }} />
          <stop offset="1" style={{ stopColor: 'var(--delhi)', stopOpacity: 0.04 }} />
        </linearGradient>
        <linearGradient id="bbArtSkyB" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--bombay)', stopOpacity: 0.42 }} />
          <stop offset="1" style={{ stopColor: 'var(--bombay)', stopOpacity: 0.04 }} />
        </linearGradient>
        <radialGradient id="bbArtSun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" style={{ stopColor: 'var(--gold)', stopOpacity: 0.9 }} />
          <stop offset="1" style={{ stopColor: 'var(--gold)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="150" height="200" fill="url(#bbArtSkyD)" />
      <rect x="150" y="0" width="150" height="200" fill="url(#bbArtSkyB)" />
      {/* stars */}
      {[[22, 26], [58, 14], [96, 34], [124, 18], [178, 22], [214, 40], [246, 16], [282, 30], [40, 52], [262, 58]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1.4 : 0.9} style={{ fill: 'var(--text)', opacity: 0.55 }} />
      ))}
      {/* the sun between them */}
      <circle cx="150" cy="78" r="44" fill="url(#bbArtSun)" />
      <circle cx="150" cy="78" r="15" style={{ fill: 'var(--gold)' }} />
      {/* India Gate */}
      <g style={{ fill: 'var(--delhi)' }}>
        <rect x="40" y="76" width="64" height="9" rx="1.5" />
        <rect x="46" y="66" width="52" height="11" rx="1.5" />
        <rect x="58" y="58" width="28" height="9" rx="1.5" />
        <path d="M42 85 H102 V170 H86 V122 A14 14 0 0 0 58 122 V170 H42 Z" />
      </g>
      {/* Gateway of India */}
      <g style={{ fill: 'var(--bombay)' }}>
        <path d="M182 104 H274 V170 H244 V134 A16 16 0 0 0 212 134 V170 H182 Z" />
        <rect x="178" y="96" width="100" height="9" rx="1.5" />
        <rect x="182" y="84" width="14" height="13" />
        <rect x="260" y="84" width="14" height="13" />
        <path d="M182 84 Q189 70 196 84 Z" />
        <path d="M260 84 Q267 70 274 84 Z" />
        <path d="M214 96 Q228 64 242 96 Z" />
        <rect x="226" y="62" width="4" height="8" />
      </g>
      {/* ground and water */}
      <rect x="0" y="170" width="150" height="30" style={{ fill: 'var(--delhi)', opacity: 0.25 }} />
      <rect x="150" y="170" width="150" height="30" style={{ fill: 'var(--bombay)', opacity: 0.25 }} />
      {[178, 186, 194].map((y, i) => (
        <path key={y} d={`M${160 + i * 8} ${y} q8 -3 16 0 t16 0 t16 0 t16 0 t16 0`} style={{ fill: 'none', stroke: 'var(--bombay)', strokeWidth: 1.2, opacity: 0.6 }} />
      ))}
      {/* VS medallion */}
      <circle cx="150" cy="150" r="17" style={{ fill: 'var(--bg)', stroke: 'var(--gold)', strokeWidth: 2 }} />
      <text x="150" y="155" textAnchor="middle" className="font-grotesk" style={{ fill: 'var(--gold)', fontSize: 13, fontWeight: 700, fontStyle: 'italic' }}>VS</text>
    </svg>
  </ArtFrame>
);

// ── How to play ──────────────────────────────────────────────────────────────
export const HowToPlayArt: React.FC = () => (
  <ArtFrame label="How a round is played" title="Pick · Tap · Win" sub="Choose a chip, tap Delhi or Bombay before bets close, and watch the result." align="center"
    backdrop="linear-gradient(160deg, color-mix(in srgb, var(--gold) 14%, transparent), transparent 55%, color-mix(in srgb, var(--bombay) 14%, transparent))">
    <svg viewBox="0 0 300 200" style={svgFill} aria-hidden="true">
      <defs>
        <linearGradient id="bbArtHow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--gold)', stopOpacity: 0.22 }} />
          <stop offset="0.55" style={{ stopColor: 'var(--surface)', stopOpacity: 0 }} />
          <stop offset="1" style={{ stopColor: 'var(--bombay)', stopOpacity: 0.22 }} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="300" height="200" fill="url(#bbArtHow)" />
      {/* dotted path between the steps */}
      <path d="M62 104 C100 60, 120 60, 150 100 S 210 140, 240 100" style={{ fill: 'none', stroke: 'var(--gold)', strokeWidth: 2, strokeDasharray: '4 6', opacity: 0.7 }} />
      {/* 1 · chip */}
      <g transform="translate(62 104)">
        <circle r="30" style={{ fill: 'var(--delhi)' }} />
        {Array.from({ length: 8 }).map((_, i) => (
          <rect key={i} x="-4" y="-30" width="8" height="9" rx="1.5" transform={`rotate(${i * 45})`} style={{ fill: 'var(--text)', opacity: 0.85 }} />
        ))}
        <circle r="18" style={{ fill: 'var(--gold)' }} />
        <text y="5" textAnchor="middle" className="font-grotesk" style={{ fill: 'var(--bg)', fontSize: 14, fontWeight: 800 }}>10</text>
      </g>
      {/* 2 · tap */}
      <g transform="translate(150 100)">
        <rect x="-30" y="-26" width="28" height="52" rx="8" style={{ fill: 'var(--delhi)', opacity: 0.85 }} />
        <rect x="2" y="-26" width="28" height="52" rx="8" style={{ fill: 'var(--bombay)', opacity: 0.85 }} />
        <circle cx="16" cy="6" r="15" style={{ fill: 'none', stroke: 'var(--text)', strokeWidth: 2, opacity: 0.6 }} />
        <circle cx="16" cy="6" r="6" style={{ fill: 'var(--text)' }} />
      </g>
      {/* 3 · trophy */}
      <g transform="translate(240 100)" style={{ fill: 'var(--gold)' }}>
        <path d="M-20 -26 H20 V-6 A20 20 0 0 1 -20 -6 Z" />
        <path d="M-20 -22 H-30 A10 10 0 0 0 -20 -2 Z" style={{ fill: 'none', stroke: 'var(--gold)', strokeWidth: 4 }} />
        <path d="M20 -22 H30 A10 10 0 0 1 20 -2 Z" style={{ fill: 'none', stroke: 'var(--gold)', strokeWidth: 4 }} />
        <rect x="-4" y="12" width="8" height="10" />
        <rect x="-14" y="22" width="28" height="7" rx="2" />
      </g>
      {[['1', 62], ['2', 150], ['3', 240]].map(([n, x]) => (
        <g key={n} transform={`translate(${x} 158)`}>
          <circle r="11" style={{ fill: 'var(--bg)', stroke: 'var(--gold)', strokeWidth: 1.5 }} />
          <text y="4" textAnchor="middle" className="font-grotesk" style={{ fill: 'var(--gold)', fontSize: 11, fontWeight: 800 }}>{n}</text>
        </g>
      ))}
    </svg>
  </ArtFrame>
);
