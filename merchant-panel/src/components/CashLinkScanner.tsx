// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Scan the cash machine's QR for a cash buy (Step 2d).
 *
 * The member stands at a machine offering UPI cash withdrawal, enters the
 * order amount, and points this at the QR it shows. The decoded link is shown
 * back (payee and amount) and, once they send it, the player gets one "Pay"
 * button for exactly that QR; the machine hands the member the cash.
 *
 * ── Camera first, a photo if the camera will not start ──────────────────────
 * The live camera needs a secure origin and a permission the member may have
 * refused. A photo (`capture="environment"`) opens the phone's own camera app
 * and needs neither, so it is always offered. Typing a link is not: a typed
 * link is not a machine's QR, and the owner ruled it out.
 *
 * ── Two decoders ─────────────────────────────────────────────────────────────
 * `BarcodeDetector` where the browser has it (Chrome on Android), jsQR on a
 * canvas everywhere else (Safari, Firefox). Both read the same pixels; the
 * first is faster, the second is the one that always exists.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, QrCode, RotateCcw, Send, X } from 'lucide-react';
import { Banner, Button } from './ui';
import { readCashLink, type CashLinkReading } from '../utils/cashLink';
import type { PaymentOrder } from '../types';

interface Props {
  order: PaymentOrder | null;
  busy: boolean;
  onClose: () => void;
  /** Send the scanned link; resolves true when the server took it. */
  onSend: (order: PaymentOrder, link: string) => Promise<boolean>;
}

/** Longest side a frame or photo is decoded at. A 12-megapixel photo is slow for jsQR and no more readable. */
const MAX_SIDE = 1280;
/** How often the live camera is read. */
const FRAME_MS = 250;

type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>> };

function barcodeDetector(): BarcodeDetectorLike | null {
  const Detector = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
  if (!Detector) return null;
  try { return new Detector({ formats: ['qr_code'] }); } catch { return null; }
}

/** Decode one image, or null when no QR is in it. */
async function decode(
  source: CanvasImageSource, width: number, height: number,
  canvas: HTMLCanvasElement, detector: BarcodeDetectorLike | null,
): Promise<string | null> {
  if (!width || !height) return null;
  if (detector) {
    try {
      const found = await detector.detect(source);
      if (found[0]?.rawValue) return found[0].rawValue;
    } catch { /* fall through to jsQR */ }
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h);
  return jsQR(pixels.data, w, h)?.data ?? null;
}

export const CashLinkScanner: React.FC<Props> = ({ order, busy, onClose, onSend }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [reading, setReading] = useState<CashLinkReading | null>(null);
  const [scanning, setScanning] = useState(false);
  const amount = Number(order?.fiatAmount ?? order?.amount ?? 0);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  const canvas = () => {
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    return canvasRef.current;
  };

  // The live camera, while the dialog is open and nothing has been read yet.
  useEffect(() => {
    if (!order || reading) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detector = barcodeDetector();

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('This browser cannot open the camera here.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        setCameraError('');
        setScanning(true);
        const tick = async () => {
          if (cancelled) return;
          const raw = await decode(video, video.videoWidth, video.videoHeight, canvas(), detector);
          if (cancelled) return;
          if (raw) {
            setReading(readCashLink(raw, amount));
            stopCamera();
            return;
          }
          timer = setTimeout(tick, FRAME_MS);
        };
        timer = setTimeout(tick, FRAME_MS);
      } catch (error) {
        const name = (error as { name?: string })?.name;
        setCameraError(name === 'NotAllowedError'
          ? 'Camera permission was refused.'
          : 'The camera could not start.');
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stopCamera();
    };
  }, [order, reading, amount, stopCamera]);

  // Escape closes, like every other dialog in the panel.
  useEffect(() => {
    if (!order) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, onClose]);

  // A fresh order starts with nothing read.
  useEffect(() => { setReading(null); setCameraError(''); }, [order?.orderId]);

  if (!order) return null;

  const fromPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const raw = await decode(bitmap, bitmap.width, bitmap.height, canvas(), barcodeDetector());
      bitmap.close?.();
      stopCamera();
      setReading(raw
        ? readCashLink(raw, amount)
        : { ok: false, message: 'No QR was found in that photo. Hold the phone steady, fill the frame with the QR, and try again.' });
    } catch {
      setReading({ ok: false, message: 'That photo could not be read. Try again.' });
    }
  };

  const send = async () => {
    if (!reading?.ok) return;
    const sent = await onSend(order, reading.link);
    if (sent) onClose();
  };

  const rupees = `₹${amount.toLocaleString('en-IN')}`;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cash-link-title"
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)', padding: 16 }}>
      <div style={{ width: 'min(94vw, 460px)', maxHeight: '94vh', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h2 id="cash-link-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
            <QrCode size={18} /> Scan the cash machine
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: '8px 0 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>
          On the machine, choose UPI cash withdrawal and enter <b>{rupees}</b>. Then scan the QR it shows.
          The player pays that QR and the machine gives you the cash.
        </p>

        {!reading && (
          <>
            <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: 'var(--surface-2)', aspectRatio: '1 / 1' }}>
              <video ref={videoRef} playsInline muted aria-label="Camera view"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: scanning ? 'block' : 'none' }} />
              {!scanning && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12.5, padding: 16, textAlign: 'center' }}>
                  {cameraError ? '' : 'Starting the camera…'}
                </div>
              )}
            </div>
            {cameraError && (
              <div role="alert" style={{ marginTop: 10 }}>
                <Banner tone="warn">{cameraError} Take a photo of the QR instead.</Banner>
              </div>
            )}
            <input ref={photoRef} type="file" accept="image/*" capture="environment" onChange={fromPhoto}
              aria-label="Photo of the machine's QR" style={{ display: 'none' }} />
            <Button variant="outline" full style={{ marginTop: 10 }} onClick={() => photoRef.current?.click()}>
              <Camera size={16} /> Take a photo of the QR instead
            </Button>
          </>
        )}

        {reading && !reading.ok && (
          <div role="alert">
            <Banner tone="danger" title="Not this QR">{reading.message}</Banner>
          </div>
        )}

        {reading?.ok && (
          <div role="status" style={{ padding: '12px 14px', background: 'var(--dep-bg)', borderRadius: 12 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>The player will pay</div>
            <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>
              ₹{reading.amountRupees.toLocaleString('en-IN')}
            </div>
            <div className="bb-mono" style={{ fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-all' }}>to {reading.payee}</div>
          </div>
        )}

        {reading && (
          <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
            <Button variant="outline" onClick={() => setReading(null)} disabled={busy}>
              <RotateCcw size={15} /> Scan again
            </Button>
            {reading.ok && (
              <Button tone="ok" onClick={() => { void send(); }} busy={busy} style={{ flex: 1 }}>
                <Send size={15} /> Send to the player
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CashLinkScanner;
