
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import { getBackend, getAssetUrl } from '../../services/backend.service';
import { apiUrl } from '../../services/apiUrl';
import { currentOrigin } from '../../services/originFailover';
import { isNativeShell } from '../../services/nativeLifecycle';
import { SystemConfigData } from '../../types';

const backend = getBackend();

interface ShareModalProps {
  onClose: () => void;
}

const ShareModal: React.FC<ShareModalProps> = ({ onClose }) => {
  const [config, setConfig] = useState<SystemConfigData | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    backend.getSystemConfig().then(setConfig).catch(console.error);
  }, []);

  const handleShare = async (title: string, url: string) => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Bazaar Clash 3D',
          text: title,
          url: url
        });
      } catch (e) {
        console.warn('Share dismissed');
      }
    } else {
      handleCopy(url, 'link');
    }
  };

  // Only claim "Copied!" once the clipboard has actually taken it. `navigator
  // .clipboard` is undefined in an insecure context and rejects when the
  // permission is refused, and the old unguarded call both threw inside the
  // click handler and reported success on a copy that never happened.
  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return void setCopied('failed');
    }
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const handleDownload = (url: string) => {
      window.open(url, '_blank');
  };

  // ── The two destinations ────────────────────────────────────────────────
  // Both are configured server-side so a domain change takes effect without a
  // rebuild, and both have to be right inside the Capacitor Android shell,
  // where `window.location.origin` is `https://localhost` — the handset itself.
  //
  // The site to invite a friend to. An unset webUrl falls back to the page
  // origin on the web; in the shell that would hand out a link to the player's
  // own device, so the deployed API origin stands in for it there.
  const webUrl = config?.webUrl || (isNativeShell() ? currentOrigin() : window.location.origin);
  // The APK. `/api/download/android` 302s to whatever androidUrl an admin has
  // set, so the indirection survives every build; `apiUrl` resolves it against
  // the API origin — byte-identical to the relative path on a same-origin web
  // deploy, and the real host in the shell.
  const androidUrl = apiUrl('/api/download/android');
  // H-06 fix: read logo from branding (GOVERNANCE §3: logos must originate from Branding).
  // Falls back to /app-assets/logo.png only when branding.logo is empty.
  const branding   = (() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}'); } catch { return {}; } })();
  const cdnBase    = (branding.cdnBaseUrl || '').replace(/\/+$/, '');
  const brandLogo  = branding.logo
    ? (branding.logo.startsWith('http') ? branding.logo : cdnBase + '/' + branding.logo.replace(/^\/+/, ''))
    : '';
  const logoUrl = brandLogo || '/app-assets/logo.png';

  return (
    <Modal onClose={onClose} title="Invite & Play">
      <div className="text-center space-y-6">
         <div className="flex justify-center mb-4">
            <div className="w-20 h-20 bg-gradient-to-br from-[#1E293B] to-[#0B0E14] rounded-2xl flex items-center justify-center border-2 border-[#D4AF37] shadow-[0_0_20px_rgba(212,175,55,0.3)]">
                {logoUrl ? (
            <img src={logoUrl} alt="Share logo" className="w-14 h-14 object-contain" />
          ) : <span className="text-3xl">🚀</span>}
            </div>
         </div>

         <div>
            <h3 className="text-white font-black text-lg uppercase tracking-wide">Earn Rewards Together</h3>
            <p className="text-slate-400 text-xs mt-1 px-4">
                Share the thrill of high-frequency prediction markets with your network.
            </p>
         </div>

         <div className="space-y-3">
            {/* OPTION 1: WEBSITE */}
            <div className="bg-[#121826] p-4 rounded-xl border border-slate-700 flex items-center justify-between group hover:border-[#D4AF37]/50 transition-colors">
                <div className="text-left">
                    <div className="text-white font-bold text-sm">Play on Web</div>
                    <div className="text-[10px] text-slate-500">Desktop & iOS Compatible</div>
                </div>
                <button 
                    onClick={() => handleShare('Join me on Bazaar Clash!', webUrl)}
                    disabled={!webUrl}
                    className="bg-[#D4AF37] hover:bg-[#B8860B] text-black font-bold px-4 py-2 rounded-lg text-xs shadow-lg transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {!webUrl ? 'Unavailable' : copied === 'failed' ? 'Copy failed' : copied === 'link' ? 'Copied!' : 'Share Link'}
                </button>
            </div>

            {/* OPTION 2: ANDROID APK */}
            <div className="bg-[#121826] p-4 rounded-xl border border-slate-700 flex items-center justify-between group hover:border-green-500/50 transition-colors">
                <div className="text-left">
                    <div className="text-white font-bold text-sm flex items-center gap-2">
                        <span>Download App</span>
                        <span className="bg-green-900/30 text-green-400 text-[9px] px-1.5 rounded border border-green-500/30">APK</span>
                    </div>
                    <div className="text-[10px] text-slate-500">Best Experience for Android</div>
                </div>
                <button 
                    onClick={() => handleDownload(androidUrl)}
                    className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-2 rounded-lg text-xs border border-slate-600 transition-transform active:scale-95 flex items-center gap-2"
                >
                    <span>⬇️</span> Download
                </button>
            </div>
         </div>

         <div className="pt-4 border-t border-slate-700">
             <div className="bg-blue-900/20 p-3 rounded-lg border border-blue-500/30">
                 <p className="text-[10px] text-blue-300">
                     <strong>iOS Users:</strong> Please use Safari and select "Add to Home Screen" for the app-like experience.
                 </p>
             </div>
         </div>
      </div>
    </Modal>
  );
};

export default ShareModal;
