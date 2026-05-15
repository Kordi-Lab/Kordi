import { loadPdfMake } from './loadPdfMake';
import { sanitizeFilename, saveBlob } from './save';
import { PDF_STYLES, tiptapJsonToPdfmakeContent, type TiptapNode } from './tiptapToPdfmake';

export async function exportScratchPdf(json: TiptapNode, scratchName: string): Promise<void> {
  const pdfMake = await loadPdfMake();
  const docDefinition = {
    pageSize: 'LETTER',
    pageMargins: [40, 60, 40, 60],
    content: tiptapJsonToPdfmakeContent(json),
    styles: PDF_STYLES,
    defaultStyle: { fontSize: 11, lineHeight: 1.35 },
  };
  const blob = await pdfMake.createPdf(docDefinition).getBlob();
  saveBlob(blob, `${sanitizeFilename(scratchName)}.pdf`);
}
