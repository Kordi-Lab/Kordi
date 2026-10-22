// The QR encoder's type only; the encoder itself loads lazily in PairQr.

export type QrFactory = typeof import('qrcode-generator');

/** One SVG path for the dark modules, a run per row, and the module count. */
export function qrModules(factory: QrFactory, value: string): { size: number; d: string } {
  const qr = factory(0, 'M');
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!qr.isDark(row, col)) continue;
      let end = col + 1;
      while (end < size && qr.isDark(row, end)) end += 1;
      d += `M${col} ${row}h${end - col}v1h${col - end}z`;
      col = end;
    }
  }
  return { size, d };
}
