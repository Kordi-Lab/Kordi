import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { DocumentShareApi } from './documentShareApi';
import type { DocumentComment, DocumentReaction, DocumentResponse } from './documentShareTypes';
import { subscribeDocumentUpdates } from './documentSyncEvents';
import { splitMarkdownBlocks } from './documentBlocks';

export const SAVE_DEBOUNCE_MS = 800;
/** `document.updated` events within this window cause one refetch. */
export const REFRESH_DEBOUNCE_MS = 300;
export const UPDATED_ELSEWHERE = 'Updated elsewhere';

type Block = { id: string; source: string };

/** The document's Markdown source: its blocks separated by a blank line. */
export function documentSourceOf(blocks: ReadonlyArray<Pick<Block, 'source'>>) {
  return blocks.map((block) => block.source).join('\n\n');
}

function sameSources(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

/**
 * Moves an unsaved draft onto a newer document, block by block. A block that
 * changed on both sides keeps the remote text and reports a conflict. When the
 * draft added or removed blocks, it survives only if the remote did not change.
 */
export function rebaseDraft(base: readonly Block[], remote: readonly Block[], draft: string) {
  const baseSources = base.map((block) => block.source);
  const remoteSources = remote.map((block) => block.source);
  const draftSources = splitMarkdownBlocks(draft).map((block) => block.source);
  if (sameSources(remoteSources, baseSources)) return { draft, conflict: false };
  if (draftSources.length !== baseSources.length || remoteSources.length !== baseSources.length) {
    return { draft: null, conflict: true };
  }
  let conflict = false;
  const merged = draftSources.map((source, index) => {
    if (source === baseSources[index]) return remoteSources[index];
    if (remoteSources[index] === baseSources[index]) return source;
    conflict = true;
    return remoteSources[index];
  });
  return { draft: sameSources(merged, remoteSources) ? null : merged.join('\n\n'), conflict };
}

/**
 * The unsaved draft of a cloud document, saved as the whole source with the
 * revision it was based on: debounced, flushed on blur and close, rebased on
 * 409 and on `document.updated` from another device.
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
  const [draft, setDraftState] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = useRef({ document, draft, onDocument, onAnnotations, saving: false });
  useLayoutEffect(() => { latest.current = { ...latest.current, document, draft, onDocument, onAnnotations }; });

  const setDraft = useCallback((next: string | null) => {
    latest.current = { ...latest.current, draft: next };
    setDraftState(next);
  }, []);

  const adoptRemote = useCallback((remote: DocumentResponse, base: DocumentResponse, pending: string | null) => {
    const rebased = pending === null ? { draft: null, conflict: false } : rebaseDraft(base.blocks, remote.blocks, pending);
    latest.current = { ...latest.current, document: remote };
    latest.current.onDocument(remote);
    setDraft(rebased.draft);
    if (rebased.conflict) setNotice(UPDATED_ELSEWHERE);
    return rebased.draft;
  }, [setDraft]);

  const flush = useCallback(async () => {
    const { document: base, draft: pending } = latest.current;
    if (!base || latest.current.saving || pending === null) return;
    latest.current.saving = true;
    setSaving(true);
    try {
      let current = base;
      let toSave: string | null = pending;
      for (let attempt = 0; attempt < 2 && toSave !== null; attempt += 1) {
        const sent: string = toSave;
        const result = await api.saveDocumentContent(current.attachmentId, { baseRevision: current.revision ?? 0, source: sent });
        // Typing that happened while the save was in flight stays pending.
        const typedSince = latest.current.draft;
        if (result.status === 'saved') {
          latest.current = { ...latest.current, document: result.document };
          latest.current.onDocument(result.document);
          setDraft(typedSince === sent ? null : typedSince);
          return;
        }
        toSave = adoptRemote(result.document, current, typedSince ?? sent);
        current = result.document;
      }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not save the document.');
    } finally {
      latest.current.saving = false;
      setSaving(false);
    }
  }, [adoptRemote, api, setDraft]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!enabled || draft === null) return undefined;
    const timer = setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, enabled, flush]);

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
            adoptRemote(remote, base, latest.current.draft);
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

  const serverSource = useMemo(() => documentSourceOf(document?.blocks ?? []), [document]);
  const source = draft ?? serverSource;
  /** Applies a change to the whole source; the result is saved after the debounce. */
  const updateSource = useCallback((change: (current: string) => string) => {
    const current = latest.current.draft ?? documentSourceOf(latest.current.document?.blocks ?? []);
    const next = change(current);
    if (next !== current) setDraft(next);
  }, [setDraft]);

  // Without a draft the blocks are the server's; with one they come from the draft, with the same ids for the same structure.
  const blocks = useMemo(
    () => (draft === null
      ? (document?.blocks ?? []).map((block) => ({ id: block.id, source: block.source }))
      : splitMarkdownBlocks(draft).map((block) => ({ id: block.id, source: block.source }))),
    [document, draft],
  );

  return { blocks, source, draft, updateSource, flush, saving, notice, clearNotice: useCallback(() => setNotice(null), []) };
}
