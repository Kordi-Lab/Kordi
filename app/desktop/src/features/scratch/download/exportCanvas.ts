import type { Editor } from 'tldraw';

import { sanitizeFilename, saveBlob } from './save';

export type CanvasExportFormat = 'png' | 'svg' | 'pdf';
export type CanvasExportCrop = 'content' | 'selection' | 'page';

export type CanvasExportOptions = {
  format: CanvasExportFormat;
  background: boolean;
  crop: CanvasExportCrop;
  /** Padding in pixels around the exported content (0–64). */
  padding: number;
};

const MIME_BY_FORMAT: Partial<Record<CanvasExportFormat, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
};

function shapeIdsForCrop(editor: Editor, crop: CanvasExportCrop) {
  if (crop === 'selection') {
    const selected = editor.getSelectedShapeIds();
    if (selected.length > 0) return selected;
    // Fall through to all-content if nothing is selected.
  }
  // Both 'content' and the selection-fallback case use all shapes on the
  // current page; tldraw computes the visual bounding box and applies padding.
  return editor.getCurrentPageShapeIds();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

export async function exportScratchCanvas(
  editor: Editor,
  scratchName: string,
  options: CanvasExportOptions,
): Promise<void> {
  const ids = [...shapeIdsForCrop(editor, options.crop)];

  if (options.format === 'pdf') {
    // Render PNG via tldraw, then wrap in a PDF page sized to fit.
    const pngResult = await editor.toImage(ids, {
      format: 'png',
      background: options.background,
      padding: options.padding,
    });
    const dataUrl = await blobToDataUrl(pngResult.blob);
    const { buildCanvasPdfBlob } = await import('./exportCanvasPdf');
    const pdfBlob = await buildCanvasPdfBlob(dataUrl, pngResult.width, pngResult.height);
    saveBlob(pdfBlob, `${sanitizeFilename(scratchName)}.pdf`);
    return;
  }

  const result = await editor.toImage(ids, {
    format: options.format,
    background: options.background,
    padding: options.padding,
  });
  const expectedMime = MIME_BY_FORMAT[options.format];
  const blob = expectedMime && result.blob.type !== expectedMime
    ? new Blob([await result.blob.arrayBuffer()], { type: expectedMime })
    : result.blob;
  saveBlob(blob, `${sanitizeFilename(scratchName)}.${options.format}`);
}
