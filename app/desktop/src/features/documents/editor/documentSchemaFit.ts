import type { JSONContent } from '@tiptap/core';
import { Fragment, type Mark, type Node as ProseMirrorNode, type NodeType, type Schema } from '@tiptap/pm/model';

/**
 * Parsed Markdown brought in line with the editor's schema, so a document
 * always opens instead of throwing "Invalid content for node …".
 *
 * Markdown allows constructs the schema does not, mostly inside list items
 * (`listItem` and `taskItem` must start with a paragraph):
 * - an item that starts with a heading, nested list, code block, quote, or
 *   image (`- ## Title`, `- - nested`, `- ```code`, `- > quote`) gets an empty
 *   paragraph in front, which saves back as `-` on its own line with the block
 *   indented under it;
 * - a block node inside a paragraph (an image in a list item) is lifted out
 *   of it, splitting the paragraph around it;
 * - anything the schema still refuses becomes paragraphs of its plain text.
 *
 * Nodes that are already valid are returned unchanged, so documents that open
 * today parse and save exactly as before.
 */
export function fitToSchema(schema: Schema, nodes: readonly JSONContent[]): JSONContent[] {
  const fitted: JSONContent[] = [];
  let built: ProseMirrorNode[] = [];
  const flush = () => {
    groupInline(built, (run) => schema.nodes.paragraph.create(null, run)).forEach((node) => fitted.push(checked(schema, node).toJSON() as JSONContent));
    built = [];
  };
  for (const node of nodes) {
    if (!isValid(schema, node)) {
      built.push(...build(schema, node));
      continue;
    }
    flush();
    fitted.push(node);
  }
  flush();
  return fitted;
}

function isValid(schema: Schema, node: JSONContent) {
  try {
    const built = schema.nodeFromJSON(node);
    built.check();
    return built.isBlock;
  } catch {
    return false;
  }
}

/** The node itself when it passes the schema's checks, its plain text as paragraphs otherwise. */
function checked(schema: Schema, node: ProseMirrorNode): ProseMirrorNode {
  try {
    node.check();
    return node;
  } catch {
    return schema.nodes.paragraph.create(null, textOf(schema, node.textContent));
  }
}

function textOf(schema: Schema, text: string) {
  return text ? [schema.text(text)] : [];
}

function marksOf(schema: Schema, node: JSONContent): Mark[] {
  try {
    return (node.marks ?? []).map((mark) => schema.markFromJSON(mark));
  } catch {
    return [];
  }
}

function plainText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(plainText).join(node.type === 'doc' || !node.content?.some((child) => child.type === 'text') ? '\n' : '');
}

/** Builds a node bottom-up; a textblock holding block nodes splits into several nodes. */
function build(schema: Schema, node: JSONContent): ProseMirrorNode[] {
  if (node.type === 'text') {
    if (!node.text) return [];
    return [schema.text(node.text, marksOf(schema, node))];
  }
  const type = node.type ? schema.nodes[node.type] : undefined;
  if (!type) {
    const text = plainText(node);
    return text ? [schema.text(text)] : [];
  }
  const children = (node.content ?? []).flatMap((child) => build(schema, child));
  const marks = marksOf(schema, node);
  if (type.isLeaf) {
    try {
      return [type.create(node.attrs ?? null, null, marks)];
    } catch {
      return [];
    }
  }
  if (type.inlineContent) {
    const parts = groupInline(children, (run) => fitted(schema, type, node.attrs, run, marks));
    return parts.length > 0 ? parts : [fitted(schema, type, node.attrs, [], marks)];
  }
  // Inline nodes loose in block content (text next to a heading in a list item) go into paragraphs.
  const blocks = groupInline(children, (run) => schema.nodes.paragraph.create(null, run));
  return [fitted(schema, type, node.attrs, blocks, marks)];
}

/** Consecutive inline nodes as one node made by `wrap`; block nodes as they are. */
function groupInline(children: readonly ProseMirrorNode[], wrap: (run: ProseMirrorNode[]) => ProseMirrorNode) {
  const grouped: ProseMirrorNode[] = [];
  let run: ProseMirrorNode[] = [];
  const flush = () => {
    if (run.length > 0) grouped.push(wrap(run));
    run = [];
  };
  for (const child of children) {
    if (child.isInline) run.push(child);
    else {
      flush();
      grouped.push(child);
    }
  }
  flush();
  return grouped;
}

/** The node with its content as given when valid, filled with what the schema requires (an item's leading paragraph), or as plain text. */
function fitted(schema: Schema, type: NodeType, attrs: JSONContent['attrs'], children: ProseMirrorNode[], marks: readonly Mark[]): ProseMirrorNode {
  const content = Fragment.from(children);
  if (type.validContent(content)) return type.create(attrs ?? null, content, marks);
  const filled = type.createAndFill(attrs ?? null, content, marks);
  if (filled && type.validContent(filled.content)) return filled;
  if (type.inlineContent) return type.create(attrs ?? null, textOf(schema, content.textBetween(0, content.size, '')), marks);
  // Block children the type refuses (a heading in a table cell) become paragraphs of their text.
  const plain = children.map((child) => (child.isTextblock && child.type !== schema.nodes.paragraph
    ? schema.nodes.paragraph.create(null, textOf(schema, child.textContent))
    : child));
  const retried = type.createAndFill(attrs ?? null, Fragment.from(plain), marks);
  if (retried && type.validContent(retried.content)) return retried;
  return schema.nodes.paragraph.create(null, textOf(schema, children.map((child) => child.textContent).join('\n')));
}
