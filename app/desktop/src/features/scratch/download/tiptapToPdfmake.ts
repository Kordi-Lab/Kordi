/**
 * Tiptap (ProseMirror) JSON -> pdfmake content tree.
 *
 * Covers the StarterKit nodes we use in the doc scratch editor:
 * doc / paragraph / heading / text(+ marks) / bulletList / orderedList /
 * listItem / codeBlock / blockquote / hardBreak / horizontalRule.
 *
 * Anything unknown is rendered as plain text so we never crash a download.
 */

export type TiptapMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
};

type PdfTextNode = {
  text: string | PdfTextNode[];
  bold?: boolean;
  italics?: boolean;
  decoration?: string;
  link?: string;
  color?: string;
  background?: string;
  font?: string;
};

type PdfBlock =
  | { text: Array<string | PdfTextNode>; style?: string; margin?: [number, number, number, number] }
  | { text: string; style?: string; margin?: [number, number, number, number]; preserveLeadingSpaces?: boolean }
  | { ul: PdfBlock[]; margin?: [number, number, number, number] }
  | { ol: PdfBlock[]; margin?: [number, number, number, number] }
  | { stack: PdfBlock[]; style?: string; margin?: [number, number, number, number] }
  | {
      canvas: Array<{
        type: 'line';
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        lineWidth: number;
        lineColor: string;
      }>;
      margin?: [number, number, number, number];
    };

function applyMarks(text: string, marks: TiptapMark[] | undefined): string | PdfTextNode {
  if (!marks || marks.length === 0) return text;
  const node: PdfTextNode = { text };
  for (const mark of marks) {
    if (mark.type === 'bold') node.bold = true;
    else if (mark.type === 'italic') node.italics = true;
    else if (mark.type === 'strike') node.decoration = 'lineThrough';
    else if (mark.type === 'code') {
      node.background = '#f1f3f5';
      node.color = '#c7254e';
    } else if (mark.type === 'link') {
      const href = (mark.attrs?.href as string | undefined) ?? '';
      node.color = '#1a73e8';
      node.decoration = 'underline';
      if (href) node.link = href;
    }
  }
  return node;
}

function inlineContent(content: TiptapNode[] | undefined): Array<string | PdfTextNode> {
  if (!content) return [];
  const out: Array<string | PdfTextNode> = [];
  for (const child of content) {
    if (child.type === 'text') {
      out.push(applyMarks(child.text ?? '', child.marks));
    } else if (child.type === 'hardBreak') {
      out.push('\n');
    } else if (child.content) {
      // Nested inline (rare with StarterKit) — flatten
      out.push(...inlineContent(child.content));
    }
  }
  return out;
}

function plainText(content: TiptapNode[] | undefined): string {
  if (!content) return '';
  let s = '';
  for (const child of content) {
    if (child.type === 'text') s += child.text ?? '';
    else if (child.type === 'hardBreak') s += '\n';
    else if (child.content) s += plainText(child.content);
  }
  return s;
}

function listItemToPdf(node: TiptapNode): PdfBlock {
  const blocks = (node.content ?? []).map(blockToPdf);
  if (blocks.length === 1) return blocks[0];
  return { stack: blocks };
}

function blockToPdf(node: TiptapNode): PdfBlock {
  switch (node.type) {
    case 'paragraph':
      return { text: inlineContent(node.content), margin: [0, 4, 0, 4] };
    case 'heading': {
      const level = Math.min(3, Math.max(1, (node.attrs?.level as number | undefined) ?? 1));
      return { text: inlineContent(node.content), style: `h${level}`, margin: [0, 12, 0, 6] };
    }
    case 'bulletList':
      return { ul: (node.content ?? []).map(listItemToPdf), margin: [0, 4, 0, 4] };
    case 'orderedList':
      return { ol: (node.content ?? []).map(listItemToPdf), margin: [0, 4, 0, 4] };
    case 'codeBlock':
      return {
        text: plainText(node.content),
        style: 'codeBlock',
        margin: [0, 4, 0, 4],
        preserveLeadingSpaces: true,
      };
    case 'blockquote':
      return {
        stack: (node.content ?? []).map(blockToPdf),
        style: 'blockquote',
        margin: [12, 4, 0, 4],
      };
    case 'horizontalRule':
      return {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#bbb' }],
        margin: [0, 6, 0, 6],
      };
    default:
      return { text: plainText([node]) };
  }
}

export function tiptapJsonToPdfmakeContent(json: TiptapNode): PdfBlock[] {
  if (json.type !== 'doc') return [];
  return (json.content ?? []).map(blockToPdf);
}

export const PDF_STYLES = {
  h1: { fontSize: 22, bold: true },
  h2: { fontSize: 18, bold: true },
  h3: { fontSize: 14, bold: true },
  blockquote: { italics: true, color: '#555' },
  codeBlock: { fontSize: 10, color: '#222', background: '#f4f4f4' },
};
