import { Mark, mergeAttributes, type MarkdownToken } from '@tiptap/core';
import Underline from '@tiptap/extension-underline';

/** Keeps leading and trailing spaces outside a delimiter pair, so `==` and `<u>` always touch text. */
function wrapTouching(inner: string, open: string, close: string) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!match || !match[2]) return inner;
  return `${match[1]}${open}${match[2]}${close}${match[3]}`;
}

/** Underline, written as `<u>…</u>` (the only inline HTML besides `<mark>` the server renders). */
export const DocumentUnderline = Underline.extend({
  renderMarkdown(node, helpers) {
    return wrapTouching(helpers.renderChildren(node), '<u>', '</u>');
  },
  markdownTokenizer: {
    name: 'underline',
    level: 'inline',
    start: (src: string) => src.indexOf('<u>'),
    tokenize(src, _tokens, lexer) {
      const match = /^<u>([\s\S]+?)<\/u>/i.exec(src);
      if (!match) return undefined;
      return { type: 'underline', raw: match[0], text: match[1], tokens: lexer.inlineTokens(match[1]) };
    },
  },
});

const HIGHLIGHT_PATTERNS = [/^==(?=[^\s=])([\s\S]*?\S)==/, /^<mark>([\s\S]+?)<\/mark>/i];

/** Highlight, written as `==text==` with the markers touching text; `<mark>` is read too. */
export const DocumentHighlight = Mark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: ({ HTMLAttributes }) => ['mark', mergeAttributes({ class: 'app-markdown-mark' }, HTMLAttributes), 0],
  markdownTokenName: 'highlight',
  parseMarkdown: (token: MarkdownToken, helpers) => helpers.applyMark('highlight', helpers.parseInline(token.tokens ?? [])),
  renderMarkdown: (node, helpers) => wrapTouching(helpers.renderChildren(node), '==', '=='),
  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src: string) => {
      const indexes = [src.search(/==(?=[^\s=])/), src.indexOf('<mark>')].filter((index) => index >= 0);
      return indexes.length ? Math.min(...indexes) : -1;
    },
    tokenize(src, _tokens, lexer) {
      for (const pattern of HIGHLIGHT_PATTERNS) {
        const match = pattern.exec(src);
        if (match) return { type: 'highlight', raw: match[0], text: match[1], tokens: lexer.inlineTokens(match[1]) };
      }
      return undefined;
    },
  },
  addCommands() {
    return {
      toggleHighlight: () => ({ commands }) => commands.toggleMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => this.editor.commands.toggleMark(this.name) };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlight: { toggleHighlight: () => ReturnType };
  }
}
