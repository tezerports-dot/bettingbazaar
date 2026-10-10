// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Images — the one place every image of the player app is set (owner,
 * 2026-10-10: "make a part for all images in admin panel make a single part
 * nowhere else ... for each device type ... and their sizes and places and
 * option to see preview before saving or removing or replacing").
 *
 * Each tab is the only editor of what it shows:
 *   promo   — home promo cards, an image per screen (promo_content_images)
 *   board   — the betting cards' backgrounds and the Refer & Earn card (Branding)
 *   logos   — the logo set (Branding) and the app's logo, splash and icons (App Assets)
 *   pages   — the Pro Tips and Rules banners (Branding) and their slides
 *   library — every uploaded file (CDN library)
 * Uploads go to S3 through a presigned URL and are served from the CDN.
 */
import React from 'react';
import { useSearchParams } from 'react-router';
import { PromoDeviceCards } from './PromoDeviceCards';
import { BrandingImages, BOARD_IMAGES, LOGO_IMAGES, PAGE_IMAGES } from './BrandingImages';
import { AppAssetsPage } from '../AppAssets/AppAssetsPage';
import { ContentSlideManager } from '../Content/ContentSlideManager';
import { CDNManager } from '../Content/CDNManager';

export const IMAGE_TABS = [
  { key: 'promo', label: 'Promo cards', sub: 'Laptop, tablet, phone, small phone' },
  { key: 'board', label: 'Game board', sub: 'Betting cards, Refer & Earn' },
  { key: 'logos', label: 'Logo & app icons', sub: 'Logo, icons, splash' },
  { key: 'pages', label: 'Page banners & slides', sub: 'Pro Tips, Rules' },
  { key: 'library', label: 'Library', sub: 'Every uploaded file' },
] as const;

type TabKey = typeof IMAGE_TABS[number]['key'];

export const ImagesPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: TabKey = (IMAGE_TABS.find((t) => t.key === asked)?.key ?? 'promo');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Images</h1>
        <p className="text-sm text-gray-400">Every image the player app shows, with the size to make it and where it appears. Changes are previewed here and go live when you save.</p>
      </div>
      <div role="tablist" aria-label="Image groups" className="flex flex-wrap gap-1 bg-dark-800 rounded-lg p-1">
        {IMAGE_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setParams({ tab: t.key })}
            className={`flex-1 min-w-[140px] py-2 px-3 rounded-md text-left transition-colors ${tab === t.key ? 'bg-dark-600 text-white' : 'text-gray-400 hover:text-white'}`}>
            <div className="text-sm font-medium">{t.label}</div>
            <div className="text-[11px] opacity-70">{t.sub}</div>
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'promo' && <PromoDeviceCards />}
        {tab === 'board' && (
          <BrandingImages fields={BOARD_IMAGES} title="Game board images"
            intro="The betting cards' backgrounds and the Refer & Earn card. Empty uses the built-in look." />
        )}
        {tab === 'logos' && (
          <div className="space-y-6">
            <BrandingImages fields={LOGO_IMAGES} title="Logo and icons"
              intro="The logo and icons the panels draw in the browser." />
            <AppAssetsPage />
          </div>
        )}
        {tab === 'pages' && (
          <div className="space-y-6">
            <BrandingImages fields={PAGE_IMAGES} title="Page banners"
              intro="The banner at the top of the Pro Tips and Rules pages." />
            <ContentSlideManager />
          </div>
        )}
        {tab === 'library' && <CDNManager />}
      </div>
    </div>
  );
};

export default ImagesPage;
