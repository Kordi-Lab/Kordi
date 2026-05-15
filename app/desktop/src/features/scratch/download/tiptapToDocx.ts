import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  TextRun,
} from 'docx';

import type { TiptapMark, TiptapNode } from './tiptapToPdfmake';

const NUM_REF = 'kordi-scratch-num';

const HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

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

type TextRunOptions = ConstructorParameters<typeof TextRun>[0];

function toTextRun(text: string, marks?: TiptapMark[]): TextRun {
  if (!marks || marks.length === 0) return new TextRun({ text });
  const opts: Record<string, unknown> = { text };
  for (const mark of marks) {
    if (mark.type === 'bold') opts.bold = true;
    else if (mark.type === 'italic') opts.italics = true;
    else if (mark.type === 'strike') opts.strike = true;
    else if (mark.type === 'code') {
      opts.font = 'Consolas';
      opts.shading = { type: ShadingType.SOLID, color: 'F1F3F5', fill: 'F1F3F5' };
    } else if (mark.type === 'link') {
      opts.color = '1A73E8';
      opts.underline = {};
    }
  }
  return new TextRun(opts as TextRunOptions);
}

function inlineRuns(content: TiptapNode[] | undefined): TextRun[] {
  if (!content || content.length === 0) return [new TextRun({ text: '' })];
  const runs: TextRun[] = [];
  for (const child of content) {
    if (child.type === 'text') runs.push(toTextRun(child.text ?? '', child.marks));
    else if (child.type === 'hardBreak') runs.push(new TextRun({ break: 1 }));
    else if (child.content) runs.push(...inlineRuns(child.content));
  }
  return runs.length > 0 ? runs : [new TextRun({ text: '' })];
}

type ParagraphOptions = ConstructorParameters<typeof Paragraph>[0];
type ListContext = { kind: 'bullet' | 'ordered'; level: number };

function listItemParagraphs(item: TiptapNode, list: ListContext): Paragraph[] {
  const out: Paragraph[] = [];
  for (const child of item.content ?? []) {
    if (child.type === 'paragraph') {
      const opts: Record<string, unknown> = { children: inlineRuns(child.content) };
      if (list.kind === 'bullet') opts.bullet = { level: list.level };
      else opts.numbering = { reference: NUM_REF, level: list.level };
      out.push(new Paragraph(opts as ParagraphOptions));
    } else if (child.type === 'bulletList') {
      out.push(...(child.content ?? []).flatMap((li) => listItemParagraphs(li, { kind: 'bullet', level: list.level + 1 })));
    } else if (child.type === 'orderedList') {
      out.push(...(child.content ?? []).flatMap((li) => listItemParagraphs(li, { kind: 'ordered', level: list.level + 1 })));
    } else {
      out.push(...blockToParagraphs(child, { indent: 0 }));
    }
  }
  return out;
}

function blockToParagraphs(node: TiptapNode, ctx: { indent: number }): Paragraph[] {
  switch (node.type) {
    case 'paragraph': {
      const opts: Record<string, unknown> = { children: inlineRuns(node.content) };
      if (ctx.indent > 0) opts.indent = { left: ctx.indent };
      return [new Paragraph(opts as ParagraphOptions)];
    }
    case 'heading': {
      const level = (node.attrs?.level as number | undefined) ?? 1;
      return [
        new Paragraph({
          children: inlineRuns(node.content),
          heading: HEADING_BY_LEVEL[level] ?? HeadingLevel.HEADING_1,
        }),
      ];
    }
    case 'bulletList':
      return (node.content ?? []).flatMap((li) => listItemParagraphs(li, { kind: 'bullet', level: 0 }));
    case 'orderedList':
      return (node.content ?? []).flatMap((li) => listItemParagraphs(li, { kind: 'ordered', level: 0 }));
    case 'codeBlock':
      return [
        new Paragraph({
          children: [new TextRun({ text: plainText(node.content), font: 'Consolas' })],
          shading: { type: ShadingType.SOLID, color: 'F4F4F4', fill: 'F4F4F4' },
        }),
      ];
    case 'blockquote':
      return (node.content ?? []).flatMap((c) => blockToParagraphs(c, { indent: 360 }));
    case 'horizontalRule':
      return [
        new Paragraph({
          border: { bottom: { color: 'BBBBBB', style: BorderStyle.SINGLE, size: 6, space: 1 } },
        }),
      ];
    default:
      return [new Paragraph({ children: [new TextRun({ text: plainText([node]) })] })];
  }
}

export async function buildScratchDocxBlob(json: TiptapNode): Promise<Blob> {
  const children = json.type === 'doc'
    ? (json.content ?? []).flatMap((node) => blockToParagraphs(node, { indent: 0 }))
    : [];
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: NUM_REF,
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.START },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBlob(doc);
}
