import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DocumentShareApi } from '@/features/documents/documentShareApi';
import type { DocumentResponse } from '@/features/documents/documentShareTypes';
import { presenceColor, type DocumentCollabState } from '@/features/documents/documentPresence';
import { UPDATED_ELSEWHERE, useCloudDocumentEdits } from '@/features/documents/useCloudDocumentEdits';
import DocumentEditor from '@/features/documents/editor/DocumentEditor';

import type { NativeBridge } from './nativeBridge';
import { toolbarState } from './editorCommands';
import { nativeProviderFactory } from './nativeProvider';

export type EditorConfig = { attachmentId: string; user: { name: string; accountId: string } };

export type EditorFlush = { current: (() => Promise<void>) | null };

/**
 * The Mac's document editor for one cloud document: joins the document's
 * collaboration room, and saves revisioned Markdown while the room is not
 * connected. The app draws the title, toolbar and presence from what this
 * reports over the bridge.
 */
export function IosDocumentEditor({ api, bridge, config, flushRef, onEditor }: {
  api: DocumentShareApi;
  bridge: NativeBridge;
  config: EditorConfig;
  flushRef: EditorFlush;
  onEditor: (editor: Editor | null) => void;
}) {
  const [document, setDocument] = useState<DocumentResponse | null>(null);
  const [collabState, setCollabState] = useState<DocumentCollabState>({ status: 'offline', peers: [] });
  const createProvider = useMemo(() => nativeProviderFactory(bridge), [bridge]);

  useEffect(() => {
    let cancelled = false;
    api.getDocument(config.attachmentId)
      .then((loaded) => {
        if (cancelled) return;
        setDocument(loaded);
        bridge.send({ type: 'loaded', title: loaded.title, canEdit: Boolean(loaded.viewerCan.edit) });
      })
      .catch((caught: unknown) => {
        if (!cancelled) bridge.send({ type: 'error', message: caught instanceof Error ? caught.message : 'Could not open this document.' });
      });
    return () => { cancelled = true; };
  }, [api, bridge, config.attachmentId]);

  const canEdit = document?.format === 'markdown' && Boolean(document.viewerCan.edit);
  const collaborating = collabState.status === 'connected';
  const onAnnotations = useCallback((_reactions: unknown, _comments: unknown, remote?: DocumentResponse) => {
    if (remote) setDocument((current) => (current ? { ...current, title: remote.title } : current));
  }, []);
  const cloud = useCloudDocumentEdits({ api, document, enabled: canEdit, collaborating, onDocument: setDocument, onAnnotations });

  const { flush } = cloud;
  useEffect(() => {
    flushRef.current = flush;
    return () => { flushRef.current = null; };
  }, [flush, flushRef]);

  useEffect(() => {
    bridge.send({ type: 'save', saving: cloud.saving, pending: cloud.draft !== null, notice: cloud.notice });
  }, [bridge, cloud.draft, cloud.notice, cloud.saving]);

  useEffect(() => {
    bridge.send({ type: 'collab', status: collabState.status, peers: collabState.peers.map(({ name, color }) => ({ name, color })) });
  }, [bridge, collabState]);

  const title = document?.title;
  useEffect(() => { if (title) bridge.send({ type: 'title', title }); }, [bridge, title]);

  const roomId = canEdit ? document?.attachmentId ?? null : null;
  const collab = useMemo(() => (roomId
    ? { api, attachmentId: roomId, user: { name: config.user.name, color: presenceColor(config.user.accountId), accountId: config.user.accountId } }
    : null), [api, config.user.accountId, config.user.name, roomId]);

  const blocks = useMemo(() => (document?.blocks ?? []).map((block) => ({ id: block.id, source: block.source })), [document]);
  const revisionKey = `${document?.attachmentId ?? ''}:${document?.revision ?? 0}:${document?.updatedAt ?? ''}`;

  const reported = useRef('');
  const watch = useCallback((editor: Editor | null) => {
    onEditor(editor);
    if (!editor) return;
    const report = () => {
      if (editor.isDestroyed) return;
      const state = toolbarState(editor);
      const key = JSON.stringify(state);
      if (key === reported.current) return;
      reported.current = key;
      bridge.send({ type: 'state', ...state });
    };
    editor.on('transaction', report);
    editor.on('focus', () => bridge.send({ type: 'focus', focused: true }));
    editor.on('blur', () => bridge.send({ type: 'focus', focused: false }));
    report();
  }, [bridge, onEditor]);

  if (!document) return null;
  if (!canEdit) return <div className="ios-editor-empty">You can't edit this document.</div>;
  return (
    <article className="app-document-article">
      <DocumentEditor
        key={document.attachmentId}
        collab={collab}
        onCollab={setCollabState}
        onSnapshot={setDocument}
        createProvider={createProvider}
        blocks={blocks}
        revisionKey={revisionKey}
        editable
        canComment={false}
        canReact={false}
        reactions={[]}
        comments={[]}
        composingBlock={null}
        renderAnnotations={() => null}
        onChange={cloud.updateSource}
        onComment={() => undefined}
        onReact={() => undefined}
        onUpdatedElsewhere={() => bridge.send({ type: 'notice', message: UPDATED_ELSEWHERE })}
        onEditor={watch}
      />
    </article>
  );
}
