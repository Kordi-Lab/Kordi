import { sanitizeFilename, saveBlob } from './save';
import { PDF_STYLES, tiptapJsonToPdfmakeContent, type TiptapNode } from './tiptapToPdfmake';

type PdfMakeApi = {
  vfs?: Record<string, string>;
  createPdf: (docDefinition: unknown) => {
    getBlob: (cb: (blob: Blob) => void, errorCb?: (err: unknown) => void) => void;
  };
};

let pdfMakeReady: Promise<PdfMakeApi> | null = null;

async function loadPdfMake(): Promise<PdfMakeApi> {
  if (pdfMakeReady) return pdfMakeReady;
  pdfMakeReady = (async () => {
    const [pdfMakeMod, vfsFontsMod] = await Promise.all([
      import('pdfmake/build/pdfmake'),
      import('pdfmake/build/vfs_fonts'),
    ]);
    const pdfMake = ((pdfMakeMod as { default?: PdfMakeApi }).default ?? pdfMakeMod) as PdfMakeApi;
    const vfsCandidate = (vfsFontsMod as { default?: unknown }).default ?? vfsFontsMod;
    const vfs =
      (vfsCandidate as { pdfMake?: { vfs?: Record<string, string> } }).pdfMake?.vfs
      ?? (vfsCandidate as { vfs?: Record<string, string> }).vfs
      ?? (vfsCandidate as Record<string, string>);
    pdfMake.vfs = vfs;
    return pdfMake;
  })();
  return pdfMakeReady;
}

export async function exportScratchPdf(json: TiptapNode, scratchName: string): Promise<void> {
  const pdfMake = await loadPdfMake();
  const docDefinition = {
    pageSize: 'LETTER',
    pageMargins: [40, 60, 40, 60],
    content: tiptapJsonToPdfmakeContent(json),
    styles: PDF_STYLES,
    defaultStyle: { fontSize: 11, lineHeight: 1.35 },
  };
  return new Promise((resolve, reject) => {
    pdfMake.createPdf(docDefinition).getBlob(
      (blob) => {
        const filename = `${sanitizeFilename(scratchName)}.pdf`;
        saveBlob(blob, filename);
        resolve();
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
