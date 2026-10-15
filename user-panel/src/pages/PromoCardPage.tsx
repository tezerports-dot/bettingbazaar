// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One home promo card's own page (`/card/:promoId`): what a tapped card opens
 * (owner, 2026-10-14: "it opens the user panel's page ... so the user can see
 * full detail of that card on that page and that adding link is optional").
 *
 * The card is read from the same door the home row reads
 * (`GET /api/v1/content/promo/HOME`, `getHomeCards`): its image for this
 * screen (else the first screen it has one for), its title, the details an
 * admin wrote (Admin › Images), and its optional link as a button.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { getAssetUrl, getBackend } from '../services/backend.service';
import type { HomePromoCard, PromoDevice } from '../types';
import ScreenShell from '../redesign/Screen';
import { cardHref } from '../redesign/BoardArt';
import { promoDeviceFor } from '../redesign/BoardExtras';
import { useViewport } from '../redesign/useViewport';

const goldButton: React.CSSProperties = {
  display: 'inline-block', padding: '12px 20px', borderRadius: 12, border: 'none', cursor: 'pointer',
  fontSize: 14, fontWeight: 800, color: 'var(--on-gold)', background: 'var(--gold-metal)', textDecoration: 'none',
};

const PromoCardPage: React.FC = () => {
  const { promoId = '' } = useParams();
  const navigate = useNavigate();
  const { vw } = useViewport();
  const [data, setData] = useState<{ cards: HomePromoCard[]; devices: PromoDevice[] } | null>(null);

  useEffect(() => {
    let alive = true;
    getBackend().getHomeCards().then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, []);

  if (!data) {
    return (
      <ScreenShell icon="🎁" title="Offer">
        <div role="status" style={{ textAlign: 'center', padding: 30, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      </ScreenShell>
    );
  }

  const card = data.cards.find((c) => c.promoId === promoId);
  if (!card) {
    return (
      <ScreenShell icon="🎁" title="Offer">
        <div role="alert" style={{ textAlign: 'center', padding: '30px 16px', color: 'var(--text2)', fontSize: 14 }}>
          This offer is no longer available.
          <div style={{ marginTop: 14 }}>
            <button type="button" onClick={() => navigate('/')} style={goldButton}>Back to the board</button>
          </div>
        </div>
      </ScreenShell>
    );
  }

  // This screen's own design, else the first screen the card has one for.
  const here = promoDeviceFor(vw, data.devices);
  const device = (here && card.images?.[here.key]) ? here : data.devices.find((d) => card.images?.[d.key]);
  const image = device ? card.images[device.key] : '';
  const link = cardHref(card.linkUrl);

  return (
    <ScreenShell icon="🎁" title={card.title || 'Offer'} maxWidth={720}>
      {image && (
        <img src={getAssetUrl(image)} alt={card.title || 'Offer'}
          style={{ display: 'block', width: '100%', aspectRatio: device ? `${device.ratio.w} / ${device.ratio.h}` : undefined, objectFit: 'cover', borderRadius: 16, border: '1px solid var(--line)' }} />
      )}
      {card.description && (
        <p style={{ marginTop: 16, fontSize: 14, lineHeight: 1.6, color: 'var(--text2)', whiteSpace: 'pre-line' }}>{card.description}</p>
      )}
      {link && (
        <a href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          style={{ ...goldButton, marginTop: 18 }}>
          {link.external ? 'Open link' : 'Go there'}
        </a>
      )}
    </ScreenShell>
  );
};

export default PromoCardPage;
