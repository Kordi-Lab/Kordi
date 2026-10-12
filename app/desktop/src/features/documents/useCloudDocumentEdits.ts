import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { DocumentShareApi } from './documentShareApi';
import type { DocumentComment, DocumentReaction, DocumentResponse } from './documentShareTypes';
import { subscribeDocumentUpdates } from './documentSyncEvents';

export const SAVE_DEBOUNCE_MS = 800;
/** `document.updated` events within this window cause one refetch. */
export const REFRESH_DEBOUNCE_MS = 300;
export const UPDATED_ELSEWHERE = 'Updated elsewhere';

type Edits = Record<string, string>;

/** The document source with unsaved block edits applied, blocks separated by a blank line. */
export function documentSourceWithEdits(document: Pick<DocumentResponse, 'blocks'>, edits: Edits) {
  return document.blocks.map((block) => edits[block.id] ?? block.source).join('\n\n');
}

/**
 * Moves unsaved block edits onto a newer document. A block that changed on
 * both sides keeps the remote text and reports a conflict.
 */
export function rebaseBlockEdits(base: Pick<DocumentResponse, 'blocks'>, remote: Pick<DocumentResponse, 'blocks'>, edits: Edits) {
  const next: Edits = {};
  let conflict = false;
  for (const [blockId, source] of Object.entries(edits)) {
    const before = base.blocks.find((block) => block.id === blockId)?.source;
    const after = remote.blocks.find((block) => block.id === blockId)?.source;
    if (before !== undefined && after !== undefined && before === after) {
      if (after !== source) next[blockId] = source;
    } else {
      conflict = true;
    }
  }
  return { edits: next, conflict };
}

/**
 * Block edits of a cloud document, saved as the whole source with the revision
 * they were based on: debounced, flushed on blur and close, rebased on 409 and
 * on `document.updated` from another device.
 */
export function useCloudDocumentEdits({
  api,
  document,
  enabled,
  onDocument,
  onAnnotations,
}: {
  api: DocumentShareApi;
  document: DocumentResponse | null;
  enabled: boolean;
  onDocument: (next: DocumentResponse) => void;
  /** Replaces reactions and comments only, leaving the blocks being edited alone. */
  onAnnotations: (reactions: DocumentReaction[], comments: DocumentComment[]) => void;
}) {
  const [edits, setEdits] = useState<Edits>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = useRef({ document, edits, onDocument, onAnnotations, saving: false });
  useLayoutEffect(() => { latest.current = { ...latest.current, document, edits, onDocument, onAnnotations }; });

  const adoptRemote = useCallback((remote: DocumentResponse, base: DocumentResponse, pending: Edits) => {
    const rebased = rebaseBlockEdits(base, remote, pending);
    latest.current = { ...latest.current, document: remote, edits: rebased.edits };
    latest.current.onDocument(remote);
    setEdits(rebased.edits);
    if (rebased.conflict) setNotice(UPDATED_ELSEWHERE);
    return rebased.edits;
  }, []);

  const flush = useCallback(async () => {
    const { document: base, edits: pending } = latest.current;
    if (!base || latest.current.saving || Object.keys(pending).length === 0) return;
    latest.current.saving = true;
    setSaving(true);
    try {
      let current = base;
      let toSave = pending;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await api.saveDocumentContent(current.attachmentId, {
          baseRevision: current.revision ?? 0,
          source: documentSourceWithEdits(current, toSave),
        });
        const typedSince = latest.current.edits;
        // Edits typed while the save was in flight stay pending.
        const later = Object.fromEntries(Object.entries(typedSince).filter(([id, text]) => toSave[id] !== text));
        if (result.status === 'saved') {
          latest.current = { ...latest.current, document: result.document, edits: later };
          latest.current.onDocument(result.document);
          setEdits(later);
          return;
        }
        toSave = adoptRemote(result.document, current, { ...toSave, ...later });
        current = result.document;
        if (Object.keys(toSave).length === 0) return;
      }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not save the document.');
    } finally {
      latest.current.saving = false;
      setSaving(false);
    }
  }, [adoptRemote, api]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const pendingCount = Object.keys(edits).length;
  useEffect(() => {
    if (!enabled || pendingCount === 0) return undefined;
    const timer = setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [edits, enabled, flush, pendingCount]);

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
          // A newer revision is a content change: merge unsaved block edits (unless our own save is in flight).
          if ((remote.revision ?? 0) > (base.revision ?? 0) && !latest.current.saving) {
            adoptRemote(remote, base, latest.current.edits);
          } else {
            latest.current.onAnnotations(remote.reactions, remote.comments);
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
  }, [adoptRemote, api, attachmentId]);

  const editBlock = useCallback((blockId: string, source: string) => {
    setEdits((current) => ({ ...current, [blockId]: source }));
  }, []);

  const blocks = useMemo(
    () => (document?.blocks ?? []).map((block) => ({ id: block.id, source: edits[block.id] ?? block.source })),
    [document, edits],
  );

  return { blocks, edits, editBlock, flush, saving, notice, clearNotice: useCallback(() => setNotice(null), []) };
}
