// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * OtpAuthQr — renders an otpauth:// URI as a scannable QR code.
 *
 * Rendered from the `qrcode` package, bundled at build time. It has to be
 * bundled rather than fetched: the platform's CSP (config/security.config.js)
 * sets script-src 'self', so a CDN-hosted QR library would be blocked and the
 * enrolment screen would silently show nothing.
 *
 * Drawn to an offscreen canvas and handed to an <img> as a data URI rather
 * than rendering a <canvas> directly, so the QR survives being screenshotted
 * or printed — which is what people actually do with recovery material.
 *
 * The secret is ALSO shown as text by the caller. That is deliberate: an
 * admin setting up on the same machine they are reading this on cannot scan
 * their own screen, and typing the secret in by hand is the documented
 * fallback in every authenticator app.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface Props {
  /** The full otpauth://totp/... URI from the server. */
  uri: string;
  size?: number;
}

export default function OtpAuthQr({ uri, size = 208 }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setDataUrl(null);
    QRCode.toDataURL(uri, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      // Fixed black-on-white regardless of panel theme: scanners cope badly
      // with low-contrast or inverted codes, and a dark-mode QR that will not
      // scan is a support ticket, not a style choice.
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [uri, size]);

  if (failed) {
    // Never leave a blank box — the typed secret is a complete substitute.
    return (
      <div
        className="flex items-center justify-center rounded-lg bg-white p-4 text-center text-xs text-red-600"
        style={{ width: size, height: size }}
      >
        Could not draw the QR code.<br />Enter the setup key manually instead.
      </div>
    );
  }

  if (!dataUrl) {
    return <div className="animate-pulse rounded-lg bg-slate-200" style={{ width: size, height: size }} />;
  }

  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt="Two-factor setup QR code"
      className="rounded-lg bg-white p-2"
    />
  );
}
