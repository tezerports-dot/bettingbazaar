// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { Backend } from './backend.interface';
import { RealBackend } from './realBackend';

// ── Singleton ──────────────────────────────────────────────────────────────────
let backendInstance: Backend | null = null;

export const getBackend = (): Backend => {
  if (!backendInstance) {
    backendInstance = new RealBackend();
  }
  return backendInstance;
};

// ── MASTER ASSET RESOLVER ─────────────────────────────────────────────────────
// Static assets bundled in /public are ALWAYS served locally — never via CDN.
// Only dynamic content assets (game backgrounds, popups, tips) use the CDN URL.

const LOCAL_STATIC_ASSETS = new Set([
    'logo.png',
    'logo-header.png',
    'icon-192.png',
    'icon-512.png',
    'icon-apple-180.png',
    'favicon-32.png',
]);

export const getAssetUrl = (path: string, fallbackUrl: string = '') => {
    if (!path) return fallbackUrl;
    if (path.startsWith('http') || path.startsWith('data:')) return path;

    const cleanFile = path.replace(/^\//, '');

    if (LOCAL_STATIC_ASSETS.has(cleanFile)) {
        return `/${cleanFile}`;
    }

    if (_cdnBaseUrl) {
        const mapping: Record<string, string> = {
            'delhi.jpg':   'Delhi.jpg',
            'bombay.jpg':  'Bomabay.jpg',
            'popup.jpg':   'Popup.jpeg',
            'rules.jpg':   'Rules.jpeg',
            'tips_bg.jpg': 'tips.jpeg',
        };
        const finalFile = mapping[cleanFile] || cleanFile;
        return `${_cdnBaseUrl}/${finalFile}`;
    }

    return fallbackUrl || `/${cleanFile}`;
};

let _cdnBaseUrl = '';
export const setCdnBaseUrl = (url: string) => {
  const clean = url.replace(/\/$/, '');
  if (clean === _cdnBaseUrl) return;
  _cdnBaseUrl = clean;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cdn_url_updated', { detail: clean }));
  }
};
export const getCdnBaseUrl = () => _cdnBaseUrl;
