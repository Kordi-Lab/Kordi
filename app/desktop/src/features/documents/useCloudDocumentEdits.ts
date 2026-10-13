import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { DocumentShareApi } from './documentShareApi';
import type { DocumentComment, DocumentReaction, DocumentResponse } from './documentShareTypes';
import { subscribeDocumentUpdates } from './documentSyncEvents';

export const SAVE_DEBOUNCE_MS = 800;
/** `document.updated` events within this window cause one refetch. */
export const REFRESH_DEBOUNCE_MS = 300;
export const UPDATED_ELSEWHERE = 'Updated elsewhere';

/**
 * The unsaved Markdown of a cloud document, saved whole with the revision it
 * was based on: debounced, flushed on blur and close. A 409 or a
 * `document.updated` hands the newer document to the editor, which merges it
 * block by block and reports its Markdown again; the next save then uses the
 * newer revision. While the document's collaboration room is connected the
 * room carries the content: no revisioned saves, and `document.updated` only
 * refreshes reactions and comments.
 */
export function useCloudDocumentEdits({
  api,
  document,
  enabled: editable,
  collaborating = false,
  onDocument,
  onAnnotations,
}: {
  api: DocumentShareApi;
  document: DocumentResponse | null;
  enabled: boolean;
  /** The collaboration room is connected. */
  collaborating?: boolean;
  onDocument: (next: DocumentResponse) => void;
  /** Replaces reactions and comments only, leaving the blocks being edited alone. */
  onAnnotations: (reactions: DocumentReaction[], comments: DocumentComment[], remote?: DocumentResponse) => void;
}) {
  const [draft, setDraftState] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled = editable && !collaborating;
  const latest = useRef({ document, draft, onDocument, onAnnotations, collaborating, saving: false, blockIds: null as Record<string, string> | null });
  useLayoutEffect(() => { latest.current = { ...latest.current, document, draft, onDocument, onAnnotations, collaborating }; });

  const setDraft = useCallback((next: string | null) => {
    latest.current = { ...latest.current, draft: next };
    setDraftState(next);
  }, []);

  const flush = useCallback(async () => {
    const { document: base, draft: pending, blockIds } = latest.current;
    if (!base || latest.current.saving || pending === null) return;
    latest.current.saving = true;
    setSaving(true);
    try {
      const result = await api.saveDocumentContent(base.attachmentId, {
        baseRevision: base.revision ?? 0,
        source: pending,
        ...(blockIds ? { blockIds } : {}),
      });
      latest.current = { ...latest.current, document: result.document };
      if (result.status === 'saved') {
        latest.current.blockIds = null;
        // Typing that happened while the save was in flight stays pending.
        if (latest.current.draft === pending) setDraft(null);
      }
      latest.current.onDocument(result.document);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not save the document.');
    } finally {
      latest.current.saving = false;
      setSaving(false);
    }
  }, [api, setDraft]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  // A newer base revision (after a conflict) restarts the timer, so the merged draft is saved again.
  const baseRevision = document?.revision ?? 0;
  useEffect(() => {
    if (!enabled || draft === null) return undefined;
    const timer = setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [baseRevision, draft, enabled, flush]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const onBlur = () => { void flush(); };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      void flush();
    };
  }, [enabled, flush]);

  // Keyed by the canonical attachment, so the original and every forwarded copy refresh together.
  const attachmentId = document?.attachmentId ?? null;
  useEffect(() => {
    if (!attachmentId) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const refresh = () => {
      timer = null;
      void api.getDocument(attachmentId)
        .then((remote) => {
          const base = latest.current.document;
          if (disposed || !base) return;
          if ((remote.revision ?? 0) > (base.revision ?? 0) && !latest.current.saving && !latest.current.collaborating) {
            latest.current = { ...latest.current, document: remote };
            latest.current.onDocument(remote);
          } else {
            latest.current.onAnnotations(remote.reactions, remote.comments, remote);
          }
        })
        .catch(() => undefined);
    };
    const unsubscribe = subscribeDocumentUpdates(attachmentId, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [api, attachmentId]);

  /** The editor's Markdown; `blockIds` maps index ids to the ids a first stamped save introduces. */
  const updateSource = useCallback((markdown: string, blockIds: Record<string, string> | null = null) => {
    latest.current.blockIds = blockIds;
    if (markdown !== latest.current.draft) setDraft(markdown);
  }, [setDraft]);

  return {
    draft,
    updateSource,
    flush,
    saving,
    notice,
    showNotice: setNotice,
    clearNotice: useCallback(() => setNotice(null), []),
  };
}
