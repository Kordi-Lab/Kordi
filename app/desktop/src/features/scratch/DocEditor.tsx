import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { useEffect, useRef } from 'react';

import { kvGet, kvSet, scratchStorageKey } from './storage/indexedDb';

const SAVE_DEBOUNCE_MS = 500;

type Props = {
  sessionId: string;
  scratchId: string;
};

export function DocEditor({ sessionId, scratchId }: Props) {
  const storageKey = scratchStorageKey(sessionId, scratchId);
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextUpdateRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
      Placeholder.configure({
        placeholder: 'Start typing… Markdown shortcuts work: # heading, - list, **bold**, `code`',
      }),
    ],
    content: '',
    onUpdate: ({ editor: instance }) => {
      if (skipNextUpdateRef.current) {
        skipNextUpdateRef.current = false;
        return;
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const keyAtSchedule = storageKeyRef.current;
      saveTimerRef.current = setTimeout(() => {
        const json = instance.getJSON();
        void kvSet(keyAtSchedule, json);
      }, SAVE_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    void kvGet<unknown>(storageKey).then((stored) => {
      if (cancelled || !editor) return;
      skipNextUpdateRef.current = true;
      if (stored && typeof stored === 'object') {
        editor.commands.setContent(stored as Parameters<typeof editor.commands.setContent>[0], { emitUpdate: false });
      } else {
        editor.commands.clearContent(false);
      }
    });
    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [editor, storageKey]);

  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  return (
    <div className="scratch-doc-editor">
      <EditorContent editor={editor} />
    </div>
  );
}
