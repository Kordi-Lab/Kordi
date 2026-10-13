import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import type { Editor } from '@tiptap/core';

export const annotationWidgetsKey = new PluginKey<DecorationSet>('documentAnnotationWidgets');

export type AnnotationWidgetsStorage = {
  /** Block ids that show reactions, comments, or a comment composer under them. */
  ids: Set<string>;
  /** One container element per block id; React portals render into them. */
  elements: Map<string, HTMLElement>;
};

export function containerFor(storage: AnnotationWidgetsStorage, id: string) {
  let element = storage.elements.get(id);
  if (!element) {
    element = document.createElement('div');
    element.className = 'app-document-annotations';
    element.contentEditable = 'false';
    element.dataset.annotationsFor = id;
    storage.elements.set(id, element);
  }
  return element;
}

/**
 * Places a non-editable container after every top-level block that has
 * annotations. The containers live outside the editable text, so typing,
 * selection, and undo never touch the comment UI rendered into them.
 */
export const AnnotationWidgets = Extension.create<Record<string, never>, AnnotationWidgetsStorage>({
  name: 'annotationWidgets',
  addStorage: () => ({ ids: new Set<string>(), elements: new Map<string, HTMLElement>() }),
  addProseMirrorPlugins() {
    const storage = this.storage;
    const build = (doc: Parameters<typeof DecorationSet.create>[0]) => {
      const decorations: Decoration[] = [];
      doc.forEach((node, offset) => {
        const id = typeof node.attrs.id === 'string' ? node.attrs.id : null;
        if (!id || !storage.ids.has(id)) return;
        decorations.push(Decoration.widget(offset + node.nodeSize, () => containerFor(storage, id), {
          key: `annotations:${id}`,
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
        }));
      });
      return DecorationSet.create(doc, decorations);
    };
    return [new Plugin<DecorationSet>({
      key: annotationWidgetsKey,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (transaction, previous, _old, state) => (transaction.docChanged || transaction.getMeta(annotationWidgetsKey) ? build(state.doc) : previous),
      },
      props: { decorations: (state) => annotationWidgetsKey.getState(state) },
    })];
  },
});

function storageOf(editor: Editor) {
  return (editor.storage as unknown as { annotationWidgets: AnnotationWidgetsStorage }).annotationWidgets;
}

/** The container for a block's annotations (created on first use). */
export function annotationContainer(editor: Editor, id: string) {
  return containerFor(storageOf(editor), id);
}

/** Sets which blocks show annotations and redraws the widgets. */
export function setAnnotatedBlocks(editor: Editor, ids: readonly string[]) {
  storageOf(editor).ids = new Set(ids);
  editor.view.dispatch(editor.state.tr.setMeta(annotationWidgetsKey, true).setMeta('addToHistory', false));
}
