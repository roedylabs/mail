/**
 * QR code for the authenticator app (package `qrcode`): the modules
 * as an SVG path, with contiguous modules of each row as one rectangle. The page draws the margin (white area).
 */
import QRCode from 'qrcode';

export interface QrSymbol {
  /** Modules per side (`viewBox="0 0 size size"`). */
  size: number;
  /** Path of the dark modules. */
  d: string;
}

export function qrSymbol(text: string): QrSymbol {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'L' });
  const size = modules.size;
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules.get(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < size && modules.get(r, c)) c++;
      d += `M${start} ${r}h${c - start}v1h-${c - start}z`;
    }
  }
  return { size, d };
}
