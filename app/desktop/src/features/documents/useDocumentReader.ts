import { useCallback, useEffect, useMemo, useState } from 'react';

import { documentReaderKey, type DocumentShareApi, type DocumentWriteTarget } from './documentShareApi';
import { useDocumentReaderHost } from './documentReaderHost';
import { advanceAgentThreads, EMPTY_AGENT_THREADS, type AgentThreadState } from './documentAgentThreads';
import {
  documentContentType,
  documentFormatForPath,
  removeCommentThread,
  replaceBlockReactions,
  upsertComment,
} from './documentReaderModel';
import type { DocumentComment, DocumentReaction, DocumentResponse, DocumentShare } from './documentShareTypes';
import { useDocumentEditing } from './useDocumentEditing';
import { blocksFromSource, type SourceBlock } from './documentBlockSource';
import { useCloudDocumentEdits } from './useCloudDocumentEdits';

/** local: a file on this Mac with no cloud copy; uploaded: a cloud attachment; public: opened from a share link. */
export type DocumentReaderMode = 'local' | 'uploaded' | 'public' | 'unavailable';

export type DocumentReaderSource = {
  path?: string | null;
  attachmentId?: string | null;
  /** File text when the file is on this Mac. */
  localSource?: string | null;
  shareToken?: string | null;
  initialDocument?: DocumentResponse | null;
};

// Attachments uploaded from this window, so the badge stays "In Kordi" when the panel remounts.
const uploadedAttachmentByPath = new Map<string, string>();

export function rememberUploadedDocument(path: string, attachmentId: string) {
  uploadedAttachmentByPath.set(path, attachmentId);
}

type LoadedDocument = {
  key: string | null;
  document: DocumentResponse | null;
  reactions: DocumentReaction[];
  comments: DocumentComment[];
  share: DocumentShare | null;
  error: string | null;
  /** Agent runs followed while the document is open, for the "Edited by" line. */
  agentThreads: AgentThreadState;
};

const EMPTY_LOADED: LoadedDocument = { key: null, document: null, reactions: [], comments: [], share: null, error: null, agentThreads: EMPTY_AGENT_THREADS };

/** Run state for a document as it arrives: its revision is the baseline, so only later edits are announced. */
function agentThreadsFrom(document: DocumentResponse, now: number) {
  return advanceAgentThreads({ ...EMPTY_AGENT_THREADS, revision: document.revision ?? 0 }, { comments: document.comments }, now);
}

function loadedFrom(key: string | null, document: DocumentResponse | null): LoadedDocument {
  return document
    ? { key, document, reactions: document.reactions, comments: document.comments, share: document.share, error: null, agentThreads: agentThreadsFrom(document, Date.now()) }
    : { ...EMPTY_LOADED, key: null };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useDocumentReader(source: DocumentReaderSource, api: DocumentShareApi, collaborating = false) {
  const host = useDocumentReaderHost();
  const path = source.path?.trim() || null;
  const [uploadedId, setUploadedId] = useState<string | null>(() => (path ? uploadedAttachmentByPath.get(path) ?? null : null));
  const attachmentId = source.attachmentId?.trim() || uploadedId;
  const shareToken = source.shareToken?.trim() || null;
  const localSource = source.localSource ?? null;
  const mode: DocumentReaderMode = shareToken
    ? 'public'
    : attachmentId
      ? 'uploaded'
      : localSource !== null
        ? 'local'
        : 'unavailable';

  const initial = source.initialDocument ?? null;
  const requestKey = mode === 'public' ? `public:${shareToken}` : mode === 'uploaded' ? `attachment:${attachmentId}` : null;
  const initialKey = initial ? (mode === 'public' ? requestKey : `attachment:${initial.attachmentId}`) : null;
  const [loaded, setLoaded] = useState<LoadedDocument>(() => loadedFrom(initialKey, initial));
  if (requestKey && requestKey === initialKey && loaded.key !== requestKey) setLoaded(loadedFrom(initialKey, initial));
  const current = loaded.key === requestKey ? loaded : EMPTY_LOADED;
  const { document, reactions, comments, share } = current;
  const agentEdits = current.agentThreads.edits;
  const loading = Boolean(requestKey) && loaded.key !== requestKey;
  const error = current.error;
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);

  const update = useCallback((change: (value: LoadedDocument) => Partial<LoadedDocument>) => {
    setLoaded((value) => ({ ...value, ...change(value) }));
  }, []);
  const setReactions = useCallback((next: (value: DocumentReaction[]) => DocumentReaction[]) => update((value) => ({ reactions: next(value.reactions) })), [update]);
  const setComments = useCallback((next: (value: DocumentComment[]) => DocumentComment[]) => {
    const now = Date.now();
    update((value) => {
      const comments = next(value.comments);
      return { comments, agentThreads: advanceAgentThreads(value.agentThreads, { comments }, now) };
    });
  }, [update]);
  const setShare = useCallback((next: DocumentShare | null) => update(() => ({ share: next })), [update]);

  useEffect(() => {
    if (!requestKey || requestKey === initialKey || loaded.key === requestKey) return undefined;
    let cancelled = false;
    const request = mode === 'public' ? api.getPublicDocument(shareToken ?? '') : api.getDocument(attachmentId ?? '');
    request
      .then((next) => { if (!cancelled) setLoaded(loadedFrom(requestKey, next)); })
      .catch((caught) => { if (!cancelled) setLoaded({ ...EMPTY_LOADED, key: requestKey, error: errorMessage(caught, 'Could not open the document.') }); });
    return () => { cancelled = true; };
  }, [api, attachmentId, initialKey, loaded.key, mode, requestKey, shareToken]);

  // A signed-in member who opens a share link can jump to the session instead.
  const [member, setMember] = useState<{ attachmentId: string; sessionId: string | null } | null>(null);
  const viewerAccountId = host.viewer?.accountId ?? null;
  const publicAttachmentId = mode === 'public' ? document?.attachmentId ?? null : null;
  useEffect(() => {
    if (!publicAttachmentId || !viewerAccountId) return undefined;
    let cancelled = false;
    api.getDocument(publicAttachmentId)
      .then((value) => {
        if (!cancelled && value.viewer !== 'public') setMember({ attachmentId: publicAttachmentId, sessionId: value.sessionId });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [api, publicAttachmentId, viewerAccountId]);
  const memberSessionId = member && member.attachmentId === publicAttachmentId ? member.sessionId : null;

  const format = document?.format ?? documentFormatForPath(path) ?? 'markdown';

  // HTML that is not on this Mac comes from the raw route: authenticated for owners and members, the share path for link readers.
  const [raw, setRaw] = useState<{ key: string; html: string | null } | null>(null);
  const [rawReloads, setRawReloads] = useState(0);
  const reloadRaw = useCallback(() => setRawReloads((count) => count + 1), []);
  const publicRawPath = mode === 'public' && format === 'html' ? document?.rawPath ?? null : null;
  const uploadedRawId = mode === 'uploaded' && format === 'html' && localSource === null && document && document.viewer !== 'public'
    ? document.attachmentId
    : null;
  const rawSource = uploadedRawId ? `attachment:${uploadedRawId}` : publicRawPath ? `public:${publicRawPath}` : null;
  const rawKey = rawSource ? `${rawSource}:${rawReloads}` : null;
  useEffect(() => {
    if (!rawKey) return undefined;
    let cancelled = false;
    const request = uploadedRawId ? api.getDocumentRaw(uploadedRawId) : api.getPublicDocumentRaw(publicRawPath ?? '');
    request
      .then((html) => { if (!cancelled) setRaw({ key: rawKey, html }); })
      .catch(() => { if (!cancelled) setRaw({ key: rawKey, html: null }); });
    return () => { cancelled = true; };
  }, [api, publicRawPath, rawKey, uploadedRawId]);
  const rawResult = raw && raw.key === rawKey ? raw : null;
  const rawHtml = rawResult?.html ?? null;
  const rawPending = Boolean(rawKey) && !rawResult;
  const editing = useDocumentEditing(mode === 'local' ? localSource ?? '' : '');

  const replaceDocument = useCallback((next: DocumentResponse) => {
    const now = Date.now();
    setLoaded((value) => ({
      ...loadedFrom(requestKey, next),
      agentThreads: value.key === requestKey
        ? advanceAgentThreads(value.agentThreads, { comments: next.comments, revision: next.revision, updatedByAgentName: next.updatedByAgentName }, now)
        : agentThreadsFrom(next, now),
    }));
  }, [requestKey]);
  const canEditCloud = mode === 'uploaded' && format === 'markdown' && Boolean(document?.viewerCan.edit);
  // `remote` is the refetched document: its blocks stay out, its revision, editing agent and title are read.
  const replaceAnnotations = useCallback((nextReactions: DocumentReaction[], nextComments: DocumentComment[], remote?: DocumentResponse) => {
    const now = Date.now();
    update((value) => ({
      document: value.document && remote ? { ...value.document, title: remote.title } : value.document,
      reactions: nextReactions,
      comments: nextComments,
      agentThreads: advanceAgentThreads(value.agentThreads, { comments: nextComments, revision: remote?.revision, updatedByAgentName: remote?.updatedByAgentName }, now),
    }));
  }, [update]);
  const cloud = useCloudDocumentEdits({ api, document, enabled: canEditCloud, collaborating, onDocument: replaceDocument, onAnnotations: replaceAnnotations });
  // A forwarded copy opens its canonical document; remember that id for this file.
  const canonicalId = document?.attachmentId ?? null;
  useEffect(() => {
    if (path && canonicalId && mode === 'uploaded' && localSource !== null) rememberUploadedDocument(path, canonicalId);
  }, [canonicalId, localSource, mode, path]);
  const onCloud = mode !== 'local';
  const canEdit = format === 'markdown' && (!onCloud || canEditCloud);

  // What the editor loads: the server's blocks or the Mac-hosted file. The editor reads them
  // on mount and when the revision key changes.
  const fileSource = localSource ?? '';
  const editorBlocks = useMemo<SourceBlock[]>(
    () => (onCloud ? (document?.blocks ?? []).map((block) => ({ id: block.id, source: block.source })) : blocksFromSource(fileSource)),
    [document, fileSource, onCloud],
  );
  const editorRevision = onCloud
    ? `${document?.attachmentId ?? ''}:${document?.revision ?? 0}:${document?.updatedAt ?? ''}`
    : `local:${fileSource.length}:${fileSource.slice(0, 64)}`;

  /** The editor's Markdown, into the cloud draft (saved) or the local draft (uploaded). */
  const { setDraftSource } = editing;
  const onEditorChange = useCallback((markdown: string, blockIds: Record<string, string> | null) => {
    if (onCloud) cloud.updateSource(markdown, blockIds);
    else setDraftSource(markdown);
  }, [cloud, onCloud, setDraftSource]);

  const viewerName = host.viewer?.displayName?.trim() || null;
  const loadedAttachmentId = document?.attachmentId ?? null;
  const writeTarget = useMemo<DocumentWriteTarget | null>(() => {
    if (mode === 'public' && shareToken && viewerName) {
      return { kind: 'public', token: shareToken, reader: { readerKey: documentReaderKey(), readerName: viewerName.slice(0, 40) } };
    }
    if (mode === 'uploaded' && loadedAttachmentId) return { kind: 'attachment', attachmentId: loadedAttachmentId };
    return null;
  }, [loadedAttachmentId, mode, shareToken, viewerName]);

  const run = useCallback(async <T,>(action: () => Promise<T>, fallback: string): Promise<T | null> => {
    setActionError(null);
    try {
      return await action();
    } catch (caught) {
      setActionError(errorMessage(caught, fallback));
      return null;
    }
  }, []);

  const toggleReaction = useCallback(async (blockId: string, reaction: string) => {
    if (!writeTarget) return;
    const next = await run(() => api.toggleReaction(writeTarget, { blockId, reaction }), 'Could not react.');
    if (next) setReactions((current) => replaceBlockReactions(current, blockId, next));
  }, [api, run, setReactions, writeTarget]);

  const postComment = useCallback(async (blockId: string, body: string, parentCommentId?: string) => {
    const text = body.trim();
    if (!writeTarget || !text) return false;
    const created = await run(() => api.createComment(writeTarget, {
      blockId,
      body: text,
      ...(parentCommentId ? { parentCommentId } : {}),
    }), 'Could not post the comment.');
    if (created) setComments((current) => upsertComment(current, created));
    return Boolean(created);
  }, [api, run, setComments, writeTarget]);

  const editComment = useCallback(async (commentId: string, body: string) => {
    const updated = await run(() => api.updateComment(commentId, { body: body.trim() }), 'Could not update the comment.');
    if (updated) setComments((current) => upsertComment(current, updated));
    return Boolean(updated);
  }, [api, run, setComments]);

  const resolveComment = useCallback(async (commentId: string) => {
    const updated = await run(() => api.updateComment(commentId, { resolved: true }), 'Could not resolve the comment.');
    if (updated) setComments((current) => upsertComment(current, updated));
  }, [api, run, setComments]);

  const deleteComment = useCallback(async (commentId: string) => {
    const done = await run(async () => { await api.deleteComment(commentId); return true; }, 'Could not delete the comment.');
    if (done) setComments((current) => removeCommentThread(current, commentId));
  }, [api, run, setComments]);

  const turnLinkOn = useCallback(async (targetAttachmentId = document?.attachmentId ?? attachmentId) => {
    if (!targetAttachmentId) return;
    setShareBusy(true);
    const created = await run(() => api.createShare(targetAttachmentId, {
      ...(host.sessionId ? { sessionId: host.sessionId } : {}),
      readersCanAskAgent: true,
    }), 'Could not turn on the link.');
    if (created) setShare(created);
    setShareBusy(false);
  }, [api, attachmentId, document?.attachmentId, host.sessionId, run, setShare]);

  const turnLinkOff = useCallback(async () => {
    if (!share) return;
    setShareBusy(true);
    const done = await run(async () => { await api.revokeShare(share.shareId); return true; }, 'Could not turn off the link.');
    if (done) setShare(null);
    setShareBusy(false);
  }, [api, run, setShare, share]);

  /** Shows `title` at once and keeps it when the server agrees; a refusal restores the old title. */
  const rename = useCallback(async (title: string) => {
    const target = document?.attachmentId;
    const previous = document?.title;
    if (!target || previous === undefined || title === previous) return false;
    const setTitle = (next: string) => update((value) => (value.document?.attachmentId === target
      ? { document: { ...value.document, title: next } }
      : {}));
    setTitle(title);
    const renamed = await run(() => api.renameDocument(target, title), 'Could not rename the document.');
    setTitle(renamed ? renamed.title : previous);
    return Boolean(renamed);
  }, [api, document?.attachmentId, document?.title, run, update]);

  const setReadersCanAskAgent = useCallback(async (value: boolean) => {
    if (!share) return;
    const updated = await run(() => api.updateShare(share.shareId, { readersCanAskAgent: value }), 'Could not update the link.');
    if (updated) setShare(updated);
  }, [api, run, setShare, share]);

  const uploadToKordi = useCallback(async () => {
    if (!path || mode !== 'local') return;
    setUploading(true);
    const draft = editing.draftSource;
    const uploaded = await run(async () => {
      const result = await api.uploadDocument(path, documentContentType(path));
      // The upload sends the file; local edits made in the reader follow as the first save.
      if (draft.trim() !== (localSource ?? '').trim()) {
        const stored = await api.getDocument(result.attachmentId);
        await api.saveDocumentContent(result.attachmentId, { baseRevision: stored.revision ?? 0, source: draft });
      }
      return result;
    }, 'Could not upload the document.');
    if (uploaded) {
      rememberUploadedDocument(path, uploaded.attachmentId);
      setUploadedId(uploaded.attachmentId);
      await turnLinkOn(uploaded.attachmentId);
    }
    setUploading(false);
  }, [api, editing.draftSource, localSource, mode, path, run, turnLinkOn]);

  return {
    mode,
    format,
    document,
    reactions,
    comments,
    agentEdits,
    share,
    loading,
    error,
    actionError,
    uploading,
    shareBusy,
    attachmentId: document?.attachmentId ?? attachmentId,
    memberSessionId,
    rawHtml,
    rawPending,
    reloadRaw,
    canComment: Boolean(writeTarget && document?.viewerCan.comment),
    canReact: Boolean(writeTarget && document?.viewerCan.react),
    canShare: mode === 'local' || Boolean(document?.viewerCan.share),
    canEdit,
    editorBlocks,
    editorRevision,
    onEditorChange,
    canEditCloud,
    onCloud,
    replaceDocument,
    saveNotice: cloud.notice,
    showSaveNotice: cloud.showNotice,
    clearSaveNotice: cloud.clearNotice,
    flushEdits: cloud.flush,
    toggleReaction,
    postComment,
    editComment,
    resolveComment,
    deleteComment,
    turnLinkOn,
    turnLinkOff,
    setReadersCanAskAgent,
    uploadToKordi,
    rename,
  };
}

export type DocumentReaderState = ReturnType<typeof useDocumentReader>;
