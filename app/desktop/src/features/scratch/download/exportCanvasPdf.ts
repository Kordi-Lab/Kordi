import { loadPdfMake } from './loadPdfMake';

/**
 * Wrap a PNG (as a data URL) into a single-page PDF sized to fit the image.
 * Uses pdfmake (already lazy-loaded for the doc-PDF path) so no extra dep.
 *
 * The output PDF is bitmap (the canvas is embedded as the rendered PNG).
 * Vector PDF for tldraw scenes would need a custom PDF builder; out of scope
 * for v1 — file a follow-up if needed.
 */
export async function buildCanvasPdfBlob(
  pngDataUrl: string,
  imgWidth: number,
  imgHeight: number,
): Promise<Blob> {
  const pdfMake = await loadPdfMake();
  // 96 DPI assumption: 1 CSS px = 0.75 pt. Keeps the PDF page the same physical
  // size as the rendered image at 100 % zoom.
  const PT_PER_PX = 0.75;
  const ptWidth = Math.max(1, imgWidth * PT_PER_PX);
  const ptHeight = Math.max(1, imgHeight * PT_PER_PX);
  const docDefinition = {
    pageSize: { width: ptWidth, height: ptHeight },
    pageMargins: [0, 0, 0, 0],
    content: [{ image: pngDataUrl, width: ptWidth, height: ptHeight }],
  };
  return pdfMake.createPdf(docDefinition).getBlob();
}
