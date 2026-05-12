import type { Editor } from 'tldraw';

import { sanitizeFilename, saveBlob } from './save';

export type CanvasExportFormat = 'png' | 'svg';
export type CanvasExportCrop = 'content' | 'selection' | 'page';

export type CanvasExportOptions = {
  format: CanvasExportFormat;
  background: boolean;
  crop: CanvasExportCrop;
  /** Padding in pixels around the exported content (0–64). */
  padding: number;
};

const MIME_BY_FORMAT: Record<CanvasExportFormat, string> = {
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

export async function exportScratchCanvas(
  editor: Editor,
  scratchName: string,
  options: CanvasExportOptions,
): Promise<void> {
  const ids = [...shapeIdsForCrop(editor, options.crop)];
  const result = await editor.toImage(ids, {
    format: options.format,
    background: options.background,
    padding: options.padding,
  });
  const blob = options.format === result.blob.type
    ? result.blob
    : new Blob([await result.blob.arrayBuffer()], { type: MIME_BY_FORMAT[options.format] });
  saveBlob(blob, `${sanitizeFilename(scratchName)}.${options.format}`);
}
