import { Editor, type JSONContent } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

import { sanitizeFilename, saveBlob } from './save';
import type { TiptapNode } from './tiptapToPdfmake';

export function exportScratchMarkdown(markdown: string, scratchName: string): void {
  const filename = `${sanitizeFilename(scratchName)}.md`;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  saveBlob(blob, filename);
}

/**
 * Serialize a stored ProseMirror JSON document to Markdown without needing a
 * mounted editor. Uses a throwaway headless Tiptap instance with the same
 * extensions as DocEditor so the round-trip matches what the user sees.
 */
export function renderJsonToMarkdown(json: TiptapNode): string {
  const editor = new Editor({
    extensions: [StarterKit, Markdown.configure({ html: false })],
    content: json as unknown as JSONContent,
  });
  try {
    const storage = editor.storage as { markdown?: { getMarkdown?: () => string } };
    const md = storage.markdown?.getMarkdown?.();
    return typeof md === 'string' ? md : '';
  } finally {
    editor.destroy();
  }
}
