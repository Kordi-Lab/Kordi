import { LoaderCircle } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { DocumentBlockView, type DocumentBlockThreadProps } from './DocumentBlock';
import type { DocumentMentionOption } from './DocumentComments';
import { DocumentHeader, DocumentTitleMeta, type DocumentBadge } from './DocumentHeader';
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
import { DocumentSelectionMenu } from './DocumentSelectionMenu';
import { blockStyleOf, isInlineFormatActive, isList, linkAt, setBlockStyle, toggleInlineFormat, toggleLink, toggleList, type InlineFormat } from './documentFormat';
import { documentInsertSnippet } from './documentReaderModel';
import { locateSelection, type SourceRange } from './documentSourceMap';
import { useDocumentSelection } from './useDocumentSelection';
import { DocumentSharePopover } from './DocumentSharePopover';
import { DocumentTabBar, DocumentTabStrip } from './DocumentTabBar';
import { useDocumentReader, type DocumentReaderSource } from './useDocumentReader';
import { themedDocumentSource, useDocumentTheme } from './documentTheme';
import { useOutsideDismiss } from './useOutsideDismiss';

export type DocumentReaderProps = DocumentReaderSource & {
  api?: DocumentShareApi;
  /** Date shown for a Mac-hosted file that has no cloud record yet. */
  dateLabel?: string | null;
  onOpenSession?: (sessionId: string) => void;
  /** Opens the Share popover on mount (visual review page). */
  initialShareOpen?: boolean;
  className?: string;
};

const INLINE_FORMATS: InlineFormat[] = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'];

function isLevelOneHeading(source: string, title: string) {
  const match = /^ {0,3}#(?!#)\s+(.+?)\s*#*\s*$/.exec(source);
  return Boolean(match && match[1].trim() === title.trim());
}

export function DocumentReader({ api: apiOverride, dateLabel, onOpenSession, initialShareOpen = false, className, ...source }: DocumentReaderProps) {
  const api = useMemo(() => apiOverride ?? documentShareApiForEnvironment(), [apiOverride]);
  const host = useDocumentReaderHost();
  const reader = useDocumentReader(source, api);
  const { document, editing, mode } = reader;
  const [shareOpen, setShareOpen] = useState(initialShareOpen);
  const [composingBlock, setComposingBlock] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const theme = useDocumentTheme(sectionRef);
  const headerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const textSelection = useDocumentSelection(bodyRef, menuRef);
  const { selection } = textSelection;
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
  const badge: DocumentBadge = mode === 'local' ? 'local' : mode === 'uploaded' ? 'cloud' : null;
  const askAgent = mode !== 'public' || Boolean(document?.viewerCan.askAgent);

  const mentionOptions = useMemo<DocumentMentionOption[]>(() => [
    ...(agentName && askAgent ? [{ name: agentName, kind: 'agent' as const }] : []),
    ...(mode === 'public' ? [] : host.people.map((name) => ({ name, kind: 'person' as const }))),
  ], [agentName, askAgent, host.people, mode]);

  const visibleBlocks = editing.currentTab === 0 && reader.blocks[0] && isLevelOneHeading(reader.blocks[0].source, title)
    ? reader.blocks.slice(1)
    : reader.blocks;

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

  // The selected text inside its block's Markdown source; formatting needs both.
  const selectedBlock = selection ? reader.blocks.find((block) => block.id === selection.blockId) ?? null : null;
  const selectedRange: SourceRange | null = selection && selectedBlock ? locateSelection(selectedBlock.source, selection.text, selection.occurrence) : null;
  const canFormat = reader.canEdit && Boolean(selectedRange);
  const active = {
    formats: selectedBlock && selectedRange ? INLINE_FORMATS.filter((format) => isInlineFormatActive(selectedBlock.source, selectedRange, format)) : [],
    list: selectedBlock ? isList(selectedBlock.source) : false,
    link: Boolean(selectedBlock && selectedRange && linkAt(selectedBlock.source, selectedRange)),
    style: selectedBlock ? blockStyleOf(selectedBlock.source) : 'text' as const,
  };
  const editSelection = (change: (source: string, range: SourceRange) => string) => {
    if (!selection || !selectedBlock || !selectedRange) return;
    const next = change(selectedBlock.source, selectedRange);
    if (next === selectedBlock.source) return;
    textSelection.restoreAfterRender(selection);
    reader.editBlock(selectedBlock.id, next);
  };

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
          fileName={fileName}
          badge={badge}
          shareOpen={shareOpen}
          onToggleShare={reader.canShare ? () => { textSelection.clear(); setShareOpen((open) => !open); } : undefined}
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
        onInsert={(tool, url) => reader.insertBlock(textSelection.currentBlockId ?? selection?.blockId ?? null, documentInsertSnippet(tool, url))}
      />
      <div ref={bodyRef} className="app-document-body" onBlur={() => { void reader.flushEdits(); }}>
        {reader.loading && !document ? (
          <div className="app-document-empty"><LoaderCircle className="animate-spin" aria-hidden="true" />Loading</div>
        ) : reader.error && !document ? (
          <div className="app-document-empty" role="alert">{mode === 'public' ? 'This link is off' : reader.error}</div>
        ) : mode === 'unavailable' ? (
          <div className="app-document-empty">Not on this Mac</div>
        ) : (
          <article className={cn('app-document-article', htmlFrame && 'is-html')}>
            <DocumentTabStrip editing={editing} />
            {editing.currentTab === 0 ? (
              <DocumentTitleMeta
                title={title}
                dateLabel={formatDocumentDate(document?.createdAt) ?? dateLabel ?? null}
                author={author}
                canMessageAuthor={Boolean(author?.accountId && author.accountId !== host.viewer?.accountId && host.canMessageAccount?.(author.accountId))}
                onMessageAuthor={author?.accountId ? () => host.messageAccount?.(author.accountId ?? '') : undefined}
              />
            ) : null}
            {htmlFrame ? <div className="app-document-block is-frame" data-document-block="b0">{htmlFrame}</div> : null}
            {(htmlFrame ? [] : visibleBlocks).map((block) => (
              <DocumentBlockView
                key={`${editing.currentTab}:${block.id}`}
                id={block.id}
                source={block.source}
                pills={editing.currentTab === 0 ? reactionPillsForBlock(reader.reactions, block.id) : []}
                threads={editing.currentTab === 0 ? commentThreadsForBlock(reader.comments, block.id) : []}
                composing={composingBlock === block.id}
                shared={blockShared}
              />
            ))}
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
            {editing.currentTab !== 0 && reader.blocks.length === 0 ? <div className="app-document-empty">Empty tab</div> : null}
            {editing.currentTab === 0 && (agentName || document?.sessionTitle) ? (
              <div className="app-document-foot">
                {agentName ? <span>From <b>{agentName}</b></span> : null}
                {document?.sessionTitle ? <span>Session <b>{document.sessionTitle}</b></span> : null}
              </div>
            ) : null}
          </article>
        )}
        {selection && textSelection.position ? (
          <DocumentSelectionMenu
            menuRef={menuRef}
            position={textSelection.position}
            canComment={reader.canComment && editing.currentTab === 0}
            canReact={reader.canReact && editing.currentTab === 0}
            canFormat={canFormat}
            writeDisabledTitle={mode === 'local' ? 'Upload to Kordi first' : 'Comments are off'}
            active={active}
            onComment={() => { setComposingBlock(selection.blockId); textSelection.clear(); }}
            onReact={(reaction) => { void reader.toggleReaction(selection.blockId, reaction); textSelection.clear(); }}
            onFormat={(format) => editSelection((text, range) => toggleInlineFormat(text, range, format))}
            onList={() => editSelection((text) => toggleList(text))}
            onBlockStyle={(style) => editSelection((text) => setBlockStyle(text, style))}
            onLink={(url) => editSelection((text, range) => toggleLink(text, range, url))}
          />
        ) : null}
      </div>
      {reader.actionError && !shareOpen ? <div className="app-document-error" role="alert">{reader.actionError}</div> : null}
      {reader.saveNotice ? (
        <div className="app-document-toast" role="status">{reader.saveNotice}</div>
      ) : null}
    </section>
  );
}
