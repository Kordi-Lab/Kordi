import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

const KEY = new PluginKey('documentCodeBlocks');
const COPIED_MS = 1200;

/** Language label and copy button, drawn over the block's top-right corner; not part of the document. */
function codeChrome(language: string) {
  return (view: EditorView, getPos: () => number | undefined) => {
    const chrome = document.createElement('span');
    chrome.className = 'app-document-code-chrome';
    chrome.contentEditable = 'false';
    if (language) {
      const label = document.createElement('span');
      label.className = 'app-document-code-language';
      label.textContent = language;
      chrome.append(label);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'app-document-code-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('mousedown', (event) => event.preventDefault());
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      const position = getPos();
      const text = position === undefined ? '' : view.state.doc.nodeAt(position - 1)?.textContent ?? '';
      void navigator.clipboard?.writeText(text).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, COPIED_MS);
      }).catch(() => undefined);
    });
    chrome.append(copy);
    return chrome;
  };
}

function decorations(doc: ProseMirrorNode) {
  const found: Decoration[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== 'codeBlock') return true;
    if (node.content.size === 0) found.push(Decoration.node(position, position + node.nodeSize, { class: 'is-empty', 'data-placeholder': 'Code' }));
    const language = typeof node.attrs.language === 'string' ? node.attrs.language.trim() : '';
    found.push(Decoration.widget(position + 1, codeChrome(language), { side: -1, ignoreSelection: true, key: `code-${language}` }));
    return false;
  });
  return DecorationSet.create(doc, found);
}

/** Code blocks as a code surface: language label, copy on hover, and a muted `Code` placeholder when empty. */
export const DocumentCodeBlocks = Extension.create({
  name: 'documentCodeBlocks',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: KEY,
      state: {
        init: (_config, state) => decorations(state.doc),
        apply: (transaction, value) => (transaction.docChanged ? decorations(transaction.doc) : value),
      },
      props: { decorations: (state) => KEY.getState(state) as DecorationSet },
    })];
  },
});
