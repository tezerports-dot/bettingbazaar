// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// A QR drawn in the browser as one SVG path: the Telegram link (TelegramStep)
// and a USDT pool buy's address (UsdtPayCard). Never an image from the server.
import QRCode from 'qrcode';

/** The QR's dark modules as one SVG path, or null when the text cannot be encoded. */
export function qrPath(text: string): { size: number; d: string } | null {
  try {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { size: modules.size, d };
  } catch {
    return null;
  }
}
