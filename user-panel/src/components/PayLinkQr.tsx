// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cash buy's pay link, drawn as a QR on a larger screen (owner, Phase A of
 * the merchants-and-agents plan).
 *
 * A cash buy is paid through the ATM QR the member scans onto the order
 * (`order_states.cash_link`, CLAUDE.md §2 "A cash buy's QR"): the player gets
 * it as a `upi://pay` link. On a phone the PAY NOW button opens their UPI app.
 * A laptop or tablet has no UPI app to open, so on a wide screen the SAME link
 * is also drawn here as a QR for the player to scan with their phone.
 *
 * ── Drawn in the browser, from the link the order already carries ──────────
 * No image comes from the server: the `qrcode` package encodes the link into a
 * grid of modules (`QRCode.create`), and this component draws them as one SVG
 * path. Nothing is sent anywhere, and there is no second copy of the link.
 *
 * ── Which screens ──────────────────────────────────────────────────────────
 * `WIDE_SCREEN_QUERY`, a viewport width. Tablets are touch screens, so a
 * pointer test would leave them out, and the owner asked for laptops AND
 * tablets. The button stays on every screen; the QR is shown beside it.
 *
 * The colours are black on white whatever the theme (§11: a UI-only constant,
 * never a business value): a QR's contrast is what the scanner reads, and a
 * light-on-dark code is one many phone scanners refuse.
 */
import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';

/** A screen this wide or wider gets the QR as well as the button. */
export const WIDE_SCREEN_QUERY = '(min-width: 768px)';

/** Whether the viewport matches `query` now, kept current as it changes. */
function useMediaQuery(query: string): boolean {
  const read = () => {
    try { return typeof window !== 'undefined' && !!window.matchMedia?.(query).matches; } catch { return false; }
  };
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    let list: MediaQueryList | null = null;
    try { list = window.matchMedia?.(query) ?? null; } catch { list = null; }
    if (!list) return undefined;
    const onChange = () => setMatches(list!.matches);
    onChange();
    list.addEventListener?.('change', onChange);
    return () => list?.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

/** The QR's modules as one SVG path, a 1×1 square per dark module. */
function qrPath(link: string): { size: number; d: string } | null {
  try {
    const { modules } = QRCode.create(link, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { size: modules.size, d };
  } catch {
    // A link too long to encode: the button still works, so say nothing here.
    return null;
  }
}

interface Props {
  /** The order's `upi://pay` link, exactly as the server sent it. */
  link: string;
  /** What it pays, for the label a screen reader hears. */
  amountLabel: string;
}

export default function PayLinkQr({ link, amountLabel }: Props) {
  const wide = useMediaQuery(WIDE_SCREEN_QUERY);
  const qr = useMemo(() => (wide && link ? qrPath(link) : null), [wide, link]);
  if (!qr) return null;
  const quiet = 4; // the quiet zone a scanner needs, in modules
  const box = qr.size + quiet * 2;
  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg
        role="img" aria-label={`QR code to pay ${amountLabel} in a UPI app`}
        viewBox={`${-quiet} ${-quiet} ${box} ${box}`} width={196} height={196}
        shapeRendering="crispEdges"
        style={{ background: 'white', borderRadius: 10 }}
      >
        <path d={qr.d} fill="black" />
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--text2)', textAlign: 'center' }}>
        Scan with any UPI app on your phone
      </figcaption>
    </figure>
  );
}
