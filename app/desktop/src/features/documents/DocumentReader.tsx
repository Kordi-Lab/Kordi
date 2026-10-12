import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';

import { cn } from '@/lib/utils';

import { DocumentBlockAnnotations, DocumentBlockView, type DocumentBlockThreadProps } from './DocumentBlock';
import type { DocumentMentionOption } from './DocumentComments';
import { DocumentHeader, type DocumentBadge } from './DocumentHeader';
import { markdownDocumentTitle } from './documentBlocks';
import { useDocumentReaderHost } from './documentReaderHost';
import {
  commentThreadsForBlock,
  documentFileName,
  documentNameWithoutExtension,
  formatDocumentDate,
  reactionPillsForBlock,
} from './documentReaderModel';
import { documentShareApiForEnvironment, type DocumentShareApi } from './documentShareApi';
import { DocumentSharePopover } from './DocumentSharePopover';
import { DocumentTabBar, DocumentTabStrip } from './DocumentTabBar';
import { useDocumentReader, type DocumentReaderSource } from './useDocumentReader';
import { themedDocumentSource, useDocumentTheme } from './documentTheme';
import { useOutsideDismiss } from './useOutsideDismiss';
import { UPDATED_ELSEWHERE } from './useCloudDocumentEdits';
import type { DocumentEditorHandle } from './editor/DocumentEditor';
import type { DocumentRoomOptions, ProviderFactory } from './editor/documentRoom';
import { presenceColor, type DocumentCollabState } from './documentPresence';

// Tiptap loads with the first document, not with the app.
const DocumentEditor = lazy(() => import('./editor/DocumentEditor'));

export type DocumentReaderProps = DocumentReaderSource & {
  api?: DocumentShareApi;
  /** Date shown for a Mac-hosted file that has no cloud record yet. */
  dateLabel?: string | null;
  onOpenSession?: (sessionId: string) => void;
  /** Opens the Share popover on mount (visual review page). */
  initialShareOpen?: boolean;
  className?: string;
  /** Exposes the Tiptap editor (tests and the review page). */
  onEditor?: (editor: Editor | null) => void;
  /** Replaces the collaboration socket and its waits (tests). */
  collabTransport?: { createProvider: ProviderFactory; timing?: DocumentRoomOptions['timing'] };
};

/** A level-1 Markdown heading (`# Title`) opens the document. */
function startsWithLevelOneHeading(source: string | undefined) {
  return /^ {0,3}#(?!#)\s+\S/.test(source ?? '');
}

export function DocumentReader({ api: apiOverride, dateLabel, onOpenSession, initialShareOpen = false, className, onEditor, collabTransport, ...source }: DocumentReaderProps) {
  const api = useMemo(() => apiOverride ?? documentShareApiForEnvironment(), [apiOverride]);
  const host = useDocumentReaderHost();
  const [collabState, setCollabState] = useState<DocumentCollabState>({ status: 'offline', peers: [] });
  const reader = useDocumentReader(source, api, collabState.status === 'connected');
  const { document, editing, mode } = reader;
  const [shareOpen, setShareOpen] = useState(initialShareOpen);
  const [composingBlock, setComposingBlock] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const theme = useDocumentTheme(sectionRef);
  const headerRef = useRef<HTMLDivElement>(null);
  const [editorHandle, setEditorHandle] = useState<DocumentEditorHandle | null>(null);
  const closeShare = useCallback(() => setShareOpen(false), []);
  useOutsideDismiss(headerRef, shareOpen, closeShare);

  const path = source.path?.trim() || '';
  const hasLocalFile = source.localSource !== null && source.localSource !== undefined;
  const fileName = document?.fileName ?? (path ? documentFileName(path) : 'Document');
  const title = document?.title
    ?? (source.localSource ? markdownDocumentTitle(source.localSource) : null)
    ?? documentNameWithoutExtension(fileName);
  const author = document?.author ?? (mode === 'local' ? host.viewer : null);
  const agentName = document?.agent?.displayName ?? host.agentName;
  const viewerIsOwner = mode === 'local' || document?.viewer === 'owner';
  const badge: DocumentBadge = mode === 'local' ? 'local' : null;
  const askAgent = mode !== 'public' || Boolean(document?.viewerCan.askAgent);

  const mentionOptions = useMemo<DocumentMentionOption[]>(() => [
    ...(agentName && askAgent ? [{ name: agentName, kind: 'agent' as const }] : []),
    ...(mode === 'public' ? [] : host.people.map((name) => ({ name, kind: 'person' as const }))),
  ], [agentName, askAgent, host.people, mode]);


  const blockShared = useMemo<DocumentBlockThreadProps>(() => ({
    agentName: askAgent ? agentName : null,
    mentionOptions,
    viewerIsOwner,
    canComment: reader.canComment,
    canReact: reader.canReact,
    shareUrl: reader.share?.shareUrl ?? null,
    actions: {
      onReply: (rootId, body) => {
        const root = reader.comments.find((comment) => comment.commentId === rootId);
        return root ? reader.postComment(root.blockId, body, rootId) : Promise.resolve(false);
      },
      onEdit: reader.editComment,
      onDelete: (commentId) => { void reader.deleteComment(commentId); },
      onResolve: (commentId) => { void reader.resolveComment(commentId); },
    },
    onToggleReaction: (blockId, reaction) => { void reader.toggleReaction(blockId, reaction); },
    onPostComment: (blockId, body) => reader.postComment(blockId, body),
    onCancelComposer: () => setComposingBlock(null),
  }), [agentName, askAgent, mentionOptions, reader, viewerIsOwner]);

  const sendInKordi = reader.attachmentId && host.sendAttachment
    ? () => {
        setShareOpen(false);
        host.sendAttachment?.({
          kind: 'file',
          name: fileName,
          mimeType: document?.contentType ?? null,
          sizeBytes: document?.sizeBytes ?? null,
          attachmentId: reader.attachmentId,
          localPath: hasLocalFile ? path : null,
        });
      }
    : undefined;
  const showInFinder = hasLocalFile && path && host.revealPath ? () => { void host.revealPath?.(path); } : undefined;
  const memberSessionId = reader.memberSessionId;

  // Editable cloud documents join their collaboration room as the signed-in viewer.
  const viewerId = host.viewer?.accountId ?? null;
  const viewerName = host.viewer?.displayName ?? '';
  const roomId = reader.canEditCloud && reader.onCloudTab && viewerId ? document?.attachmentId ?? null : null;
  const collab = useMemo(() => (roomId && viewerId
    ? { api, attachmentId: roomId, user: { name: viewerName, color: presenceColor(viewerId), accountId: viewerId } }
    : null), [api, roomId, viewerId, viewerName]);

  // HTML never runs scripts here (empty sandbox, no same origin) and sits on the app surface in the app theme.
  const htmlSource = hasLocalFile ? source.localSource ?? '' : reader.rawHtml;
  const htmlFrame = reader.format === 'html' && editing.currentTab === 0
    ? htmlSource !== null
      ? (
        <iframe
          title={`${fileName} preview`}
          sandbox=""
          srcDoc={themedDocumentSource(htmlSource, theme)}
          className="app-document-frame"
          style={{ background: 'transparent', colorScheme: theme.scheme }}
          {...{ allowtransparency: 'true' }}
        />
      )
      : <div className="app-document-empty">{reader.rawPending ? 'Loading' : 'No preview'}</div>
    : null;

  return (
    <section ref={sectionRef} className={cn('app-document-reader', className)} data-document-mode={mode} aria-label={title}>
      <div ref={headerRef} className="app-document-header-wrap">
        <DocumentHeader
          title={startsWithLevelOneHeading(reader.editorBlocks[0]?.source) ? null : title}
          dateLabel={formatDocumentDate(document?.createdAt) ?? dateLabel ?? null}
          author={author}
          canMessageAuthor={Boolean(author?.accountId && author.accountId !== host.viewer?.accountId && host.canMessageAccount?.(author.accountId))}
          onMessageAuthor={author?.accountId ? () => host.messageAccount?.(author.accountId ?? '') : undefined}
          badge={badge}
          shareOpen={shareOpen}
          onToggleShare={reader.canShare ? () => setShareOpen((open) => !open) : undefined}
          presence={collab && collabState.status === 'connected' ? collabState.peers : []}
          onOpenSession={memberSessionId && onOpenSession ? () => onOpenSession(memberSessionId) : undefined}
          sharePopover={(
            <DocumentSharePopover
              local={mode === 'local'}
              share={reader.share}
              agentName={agentName}
              title={title}
              uploading={reader.uploading}
              busy={reader.shareBusy}
              error={reader.actionError}
              onUpload={() => { void reader.uploadToKordi(); }}
              onLinkOn={() => { void reader.turnLinkOn(); }}
              onLinkOff={() => { void reader.turnLinkOff(); }}
              onReadersCanAskAgent={(value) => { void reader.setReadersCanAskAgent(value); }}
              onSendInKordi={sendInKordi}
              onShowInFinder={showInFinder}
            />
          )}
        />
      </div>
      <DocumentTabBar
        editing={editing}
        canInsert={reader.canEdit}
        onInsert={(tool, url) => editorHandle?.insert(tool, url)}
      />
      <div ref={bodyRef} className="app-document-body">
        {reader.loading && !document ? (
          <div className="app-document-empty"><LoaderCircle className="animate-spin" aria-hidden="true" />Loading</div>
        ) : reader.error && !document ? (
          <div className="app-document-empty" role="alert">{mode === 'public' ? 'This link is off' : reader.error}</div>
        ) : mode === 'unavailable' ? (
          <div className="app-document-empty">Not on this Mac</div>
        ) : (
          <article className={cn('app-document-article', htmlFrame && 'is-html')}>
            <DocumentTabStrip editing={editing} />
            {htmlFrame ? <div className="app-document-block is-frame" data-document-block="b0">{htmlFrame}</div> : null}
            {htmlFrame ? null : (
              <Suspense fallback={<div className="app-document-empty"><LoaderCircle className="animate-spin" aria-hidden="true" />Loading</div>}>
                <DocumentEditor
                  key={`${editing.currentTab}:${reader.attachmentId ?? source.path ?? ''}`}
                  collab={collab}
                  onCollab={setCollabState}
                  onSnapshot={reader.replaceDocument}
                  createProvider={collabTransport?.createProvider}
                  roomTiming={collabTransport?.timing}
                  blocks={reader.editorBlocks}
                  revisionKey={reader.editorRevision}
                  editable={reader.canEdit}
                  canComment={reader.canComment && editing.currentTab === 0}
                  canReact={reader.canReact && editing.currentTab === 0}
                  reactions={editing.currentTab === 0 ? reader.reactions : []}
                  comments={editing.currentTab === 0 ? reader.comments : []}
                  composingBlock={composingBlock}
                  renderAnnotations={(blockId) => (
                    <DocumentBlockAnnotations
                      id={blockId}
                      pills={reactionPillsForBlock(reader.reactions, blockId)}
                      threads={commentThreadsForBlock(reader.comments, blockId)}
                      composing={composingBlock === blockId}
                      shared={blockShared}
                    />
                  )}
                  onChange={reader.onEditorChange}
                  onComment={(blockId) => setComposingBlock(blockId)}
                  onReact={(blockId, reaction) => { void reader.toggleReaction(blockId, reaction); }}
                  onUpdatedElsewhere={() => reader.showSaveNotice(UPDATED_ELSEWHERE)}
                  onReady={setEditorHandle}
                  onEditor={onEditor}
                />
              </Suspense>
            )}
            {htmlFrame && editing.currentTab === 0 ? (
              <DocumentBlockView
                id="b0"
                source=""
                pills={reactionPillsForBlock(reader.reactions, 'b0')}
                threads={commentThreadsForBlock(reader.comments, 'b0')}
                composing={composingBlock === 'b0'}
                shared={blockShared}
              />
            ) : null}
            {editing.currentTab === 0 && (agentName || document?.sessionTitle) ? (
              <div className="app-document-foot">
                {agentName ? <span>From <b>{agentName}</b></span> : null}
                {document?.sessionTitle ? <span>Session <b>{document.sessionTitle}</b></span> : null}
              </div>
            ) : null}
          </article>
        )}
      </div>
      {reader.actionError && !shareOpen ? <div className="app-document-error" role="alert">{reader.actionError}</div> : null}
      {reader.saveNotice ? (
        <div className="app-document-toast" role="status">{reader.saveNotice}</div>
      ) : null}
    </section>
  );
}
