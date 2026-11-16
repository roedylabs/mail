import { describe, expect, it } from 'vitest';
import { qrSymbol } from './qr.ts';

describe('qrSymbol', () => {
  it('draws the modules as a path with finder patterns in the corners', () => {
    const uri =
      'otpauth://totp/Roedy%20Mail:jonas%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Roedy%20Mail';
    const { size, d } = qrSymbol(uri);
    // Version 5 at error correction L (enough on screen, the modules stay larger).
    expect(size).toBe(37);
    // First row: finder pattern on the left (7 modules) and on the right.
    expect(d.startsWith('M0 0h7v1h-7z')).toBe(true);
    expect(d).toContain(`M${size - 7} 0h7v1h-7z`);
    // Only whole rectangles inside the symbol.
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(size);
      expect(Number(y)).toBeLessThan(size);
    }
  });
});
