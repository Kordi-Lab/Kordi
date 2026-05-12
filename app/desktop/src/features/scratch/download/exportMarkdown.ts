import { sanitizeFilename, saveBlob } from './save';

export function exportScratchMarkdown(markdown: string, scratchName: string): void {
  const filename = `${sanitizeFilename(scratchName)}.md`;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  saveBlob(blob, filename);
}
