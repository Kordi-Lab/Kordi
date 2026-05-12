import { sanitizeFilename, saveBlob } from './save';
import type { TiptapNode } from './tiptapToPdfmake';

export async function exportScratchDocx(json: TiptapNode, scratchName: string): Promise<void> {
  // Lazy: pulls the docx library + the converter only when the user actually downloads.
  const { buildScratchDocxBlob } = await import('./tiptapToDocx');
  const blob = await buildScratchDocxBlob(json);
  saveBlob(blob, `${sanitizeFilename(scratchName)}.docx`);
}
