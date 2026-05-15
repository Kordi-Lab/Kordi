type PdfMakeApi = {
  vfs?: Record<string, string>;
  addVirtualFileSystem?: (vfs: Record<string, string>) => void;
  createPdf: (docDefinition: unknown) => {
    getBlob: () => Promise<Blob>;
  };
};

let pdfMakeReady: Promise<PdfMakeApi> | null = null;

/**
 * Lazy-load pdfmake + its bundled vfs fonts and register the fonts on the
 * pdfMake instance. Cached after first call so subsequent exports don't
 * re-import the (~1.5 MB) chunk. Used by both the doc-PDF and canvas-PDF
 * exporters.
 */
export async function loadPdfMake(): Promise<PdfMakeApi> {
  if (pdfMakeReady) return pdfMakeReady;
  pdfMakeReady = (async () => {
    const [pdfMakeMod, vfsFontsMod] = await Promise.all([
      import('pdfmake/build/pdfmake'),
      import('pdfmake/build/vfs_fonts'),
    ]);
    const pdfMake = ((pdfMakeMod as { default?: PdfMakeApi }).default ?? pdfMakeMod) as PdfMakeApi;
    const vfsCandidate = (vfsFontsMod as { default?: unknown }).default ?? vfsFontsMod;
    const vfs = (
      (vfsCandidate as { pdfMake?: { vfs?: Record<string, string> } }).pdfMake?.vfs
      ?? (vfsCandidate as { vfs?: Record<string, string> }).vfs
      ?? (vfsCandidate as Record<string, string>)
    );
    if (typeof pdfMake.addVirtualFileSystem === 'function') {
      pdfMake.addVirtualFileSystem(vfs);
    } else {
      pdfMake.vfs = vfs;
    }
    return pdfMake;
  })();
  return pdfMakeReady;
}

export type { PdfMakeApi };
