// Single import site for the QR encoder so the rest of the package stays
// renderer-agnostic. SVG output: no canvas dependency, crisp at any size,
// and renderable in test DOMs.

import QRCode from 'qrcode';

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}
