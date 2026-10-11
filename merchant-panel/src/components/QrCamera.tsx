// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The camera, and a photo when the camera will not start: reads ONE QR and
 * hands back what it says. Shared by the cash machine scanner (Step 2d) and
 * the merchant account's UPI QR (owner, 2026-10-11), which each judge what
 * was read in their own terms.
 *
 * ── Camera first, a photo if the camera will not start ──────────────────────
 * The live camera needs a secure origin and a permission the member may have
 * refused. A photo (`capture="environment"`) opens the phone's own camera app
 * and needs neither, so it is always offered. Typing a link is not: what is
 * paid is a QR that was scanned, and the owner ruled typing out.
 *
 * ── Two decoders ─────────────────────────────────────────────────────────────
 * `BarcodeDetector` where the browser has it (Chrome on Android), jsQR on a
 * canvas everywhere else (Safari, Firefox). Both read the same pixels; the
 * first is faster, the second is the one that always exists.
 *
 * Mounted only while something is to be read: unmounting stops the camera.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera } from 'lucide-react';
import { Banner, Button } from './ui';

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

/** What was read: the QR's text, or why nothing was. */
export type QrRead = { raw: string } | { error: string };

export const QrCamera: React.FC<{
  /** Called once with the first QR read, or with why a photo could not be read. */
  onRead: (read: QrRead) => void;
  /** The photo input's accessible name, e.g. "Photo of the machine's QR". */
  photoLabel: string;
}> = ({ onRead, photoLabel }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const [cameraError, setCameraError] = useState('');
  const [scanning, setScanning] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  const canvas = () => {
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    return canvasRef.current;
  };

  // The live camera, while mounted.
  useEffect(() => {
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
            stopCamera();
            onReadRef.current({ raw });
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
  }, [stopCamera]);

  const fromPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const raw = await decode(bitmap, bitmap.width, bitmap.height, canvas(), barcodeDetector());
      bitmap.close?.();
      stopCamera();
      onReadRef.current(raw
        ? { raw }
        : { error: 'No QR was found in that photo. Hold the phone steady, fill the frame with the QR, and try again.' });
    } catch {
      onReadRef.current({ error: 'That photo could not be read. Try again.' });
    }
  };

  return (
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
        aria-label={photoLabel} style={{ display: 'none' }} />
      <Button variant="outline" full style={{ marginTop: 10 }} onClick={() => photoRef.current?.click()}>
        <Camera size={16} /> Take a photo of the QR instead
      </Button>
    </>
  );
};

export default QrCamera;
