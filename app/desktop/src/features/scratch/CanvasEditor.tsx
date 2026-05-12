import 'tldraw/tldraw.css';

import { Tldraw, getSnapshot, loadSnapshot, type Editor } from 'tldraw';
import { useCallback, useEffect, useRef } from 'react';

import { kvGet, kvSet, scratchStorageKey } from './storage/indexedDb';

const SAVE_DEBOUNCE_MS = 1000;

type Props = {
  sessionId: string;
  scratchId: string;
};

type StoredSnapshot = Parameters<typeof loadSnapshot>[1];

export function CanvasEditor({ sessionId, scratchId }: Props) {
  const storageKey = scratchStorageKey(sessionId, scratchId);
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleMount = useCallback(
    (editor: Editor) => {
      let cancelled = false;
      void kvGet<StoredSnapshot>(storageKey).then((stored) => {
        if (cancelled || !stored) return;
        try {
          loadSnapshot(editor.store, stored);
        } catch {
          // corrupt or incompatible snapshot — start blank
        }
      });

      const unlisten = editor.store.listen(
        () => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          const keyAtSchedule = storageKeyRef.current;
          saveTimerRef.current = setTimeout(() => {
            try {
              const snapshot = getSnapshot(editor.store);
              void kvSet(keyAtSchedule, snapshot);
            } catch {
              // serialisation failure, swallow
            }
          }, SAVE_DEBOUNCE_MS);
        },
        { scope: 'document' },
      );

      cleanupRef.current = () => {
        cancelled = true;
        unlisten();
      };
    },
    [storageKey],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="scratch-canvas-editor">
      <Tldraw key={storageKey} onMount={handleMount} />
    </div>
  );
}

export default CanvasEditor;
