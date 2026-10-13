import { AtSign, Check, MoreHorizontal } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

import { agentRunLine, canDeleteAgentReply, mentionedAgentName, prefixMention, threadAgentName } from './documentAgentThreads';
import {
  appendMention,
  formatCommentTime,
  mentionSegments,
  type CommentThread,
} from './documentReaderModel';
import type { DocumentComment } from './documentShareTypes';
import { useOutsideDismiss } from './useOutsideDismiss';

export type DocumentMentionOption = { name: string; kind: 'agent' | 'person' };

export type DocumentThreadActions = {
  onReply: (rootId: string, body: string) => Promise<boolean>;
  onEdit: (commentId: string, body: string) => Promise<boolean>;
  onDelete: (commentId: string) => void;
  onResolve: (commentId: string) => void;
};

function copyText(value: string) {
  void globalThis.navigator?.clipboard?.writeText(value).catch(() => undefined);
}

function CommentBody({ body, names }: { body: string; names: string[] }) {
  return (
    <div className="app-document-comment-body">
      {mentionSegments(body, names).map((segment, index) => (segment.mention
        ? <span key={index} className="app-document-comment-mention">{segment.text}</span>
        : <span key={index}>{segment.text}</span>))}
    </div>
  );
}

/** Comment field with an `@` picker for the session agent and people. */
export function DocumentCommentComposer({
  placeholder,
  mentionOptions,
  initialValue = '',
  submitLabel = 'Post',
  offerAgent,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  mentionOptions: DocumentMentionOption[];
  initialValue?: string;
  submitLabel?: string;
  /** Agent the field offers to ask for an edit; the offer starts the reply with its mention. */
  offerAgent?: string | null;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(initialValue);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  useOutsideDismiss(formRef, pickerOpen, closePicker);

  const submit = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    const posted = await onSubmit(draft);
    setBusy(false);
    if (posted) setDraft('');
  };

  return (
    <form
      ref={formRef}
      className={offerAgent ? 'app-document-composer has-offer' : 'app-document-composer'}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      {offerAgent ? (
        <div className="app-document-composer-offer">
          <button
            type="button"
            onClick={() => {
              setDraft((current) => prefixMention(current, offerAgent));
              inputRef.current?.focus();
            }}
          >
            Ask {offerAgent} to edit
          </button>
        </div>
      ) : null}
      {mentionOptions.length > 0 ? (
        <button
          type="button"
          className="app-document-composer-at"
          aria-label="Mention"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
        >
          <AtSign aria-hidden="true" />
        </button>
      ) : null}
      {pickerOpen ? (
        <div className="app-document-menu app-document-mention-list" role="menu" aria-label="Mention">
          {mentionOptions.map((option) => (
            <button
              key={`${option.kind}:${option.name}`}
              type="button"
              role="menuitem"
              className="app-document-menu-row"
              onClick={() => {
                setDraft((current) => appendMention(current, option.name));
                setPickerOpen(false);
                inputRef.current?.focus();
              }}
            >
              <IdentityAvatar kind={option.kind === 'agent' ? 'agent' : 'human'} seed={option.name} name={option.name} className="app-document-avatar-small" />
              <span className="app-document-menu-label">{option.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <input
        ref={inputRef}
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        maxLength={4000}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && onCancel) onCancel(); }}
      />
      <button type="submit" className="app-document-composer-post" disabled={busy || !draft.trim()}>{submitLabel}</button>
    </form>
  );
}

function CommentHeader({
  comment,
  canManage,
  canResolve,
  shareUrl,
  onEdit,
  onDelete,
  onResolve,
}: {
  comment: DocumentComment;
  /** Opens the menu: the author of a comment, or whoever may delete an agent reply. */
  canManage: boolean;
  canResolve: boolean;
  shareUrl: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onResolve?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenuOpen(false), []);
  useOutsideDismiss(menuRef, menuOpen, close);
  const isAgent = comment.kind === 'agent';
  return (
    <div className="app-document-comment-head" ref={menuRef}>
      {isAgent
        ? <IdentityAvatar kind="agent" seed={comment.author.agentId || comment.author.displayName} name={comment.author.displayName} imageUrl={comment.author.avatarUrl} className="app-document-avatar-small" />
        : <IdentityAvatar kind="human" seed={comment.author.accountId || comment.author.displayName} name={comment.author.displayName} imageUrl={comment.author.avatarUrl} className="app-document-avatar-small" />}
      <div className="app-document-comment-name">
        {comment.author.displayName}
        {isAgent ? <span className="app-document-agent-tag">Agent</span> : null}
        <span>{formatCommentTime(comment.createdAt)}</span>
      </div>
      {canManage ? (
        <button type="button" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <MoreHorizontal aria-hidden="true" />
        </button>
      ) : null}
      {canResolve && onResolve ? (
        <button type="button" aria-label="Resolve" title="Resolve" onClick={onResolve}>
          <Check aria-hidden="true" />
        </button>
      ) : null}
      {menuOpen ? (
        <div className="app-document-menu app-document-comment-menu" role="menu">
          {shareUrl ? (
            <button type="button" role="menuitem" className="app-document-menu-row" onClick={() => { copyText(`${shareUrl}#${comment.commentId}`); close(); }}>
              <span className="app-document-menu-label">Copy link</span>
            </button>
          ) : null}
          {isAgent ? null : (
            <button type="button" role="menuitem" className="app-document-menu-row" onClick={() => { onEdit(); close(); }}>
              <span className="app-document-menu-label">Edit</span>
            </button>
          )}
          {isAgent && !shareUrl ? null : <hr />}
          <button type="button" role="menuitem" className="app-document-menu-row is-danger" onClick={() => { onDelete(); close(); }}>
            <span className="app-document-menu-label">Delete comment</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** "<Agent> is working", or "Could not answer" with Retry, under the comment that asked. */
function AgentRunStatus({ line, agentName, onRetry }: {
  line: 'working' | 'failed';
  agentName: string;
  onRetry?: () => Promise<boolean>;
}) {
  const [retrying, setRetrying] = useState(false);
  if (line === 'working') {
    return (
      <div className="app-document-agent-working" role="status">
        <span className="app-document-working-dots" aria-hidden="true"><i /><i /><i /></span>
        {agentName} is working
      </div>
    );
  }
  return (
    <div className="app-document-agent-failed" role="status">
      Could not answer
      {onRetry ? (
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void onRetry().finally(() => setRetrying(false));
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** One open thread under a block: the comment, its replies, and a reply field. */
export function DocumentThread({
  thread,
  agentName,
  mentionOptions,
  viewerIsOwner,
  canReply,
  canAskEdit = false,
  editedBy = null,
  shareUrl,
  actions,
}: {
  thread: CommentThread;
  agentName: string | null;
  mentionOptions: DocumentMentionOption[];
  viewerIsOwner: boolean;
  canReply: boolean;
  /** The viewer may edit the document, so an agent can be asked to. */
  canAskEdit?: boolean;
  /** Agent whose edit arrived during this thread's run. */
  editedBy?: string | null;
  shareUrl: string | null;
  actions: DocumentThreadActions;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const names = mentionOptions.map((option) => option.name);
  const agentNames = mentionOptions.filter((option) => option.kind === 'agent').map((option) => option.name);
  const answeredBy = threadAgentName(thread);
  const renderComment = (comment: DocumentComment, isRoot: boolean) => {
    if (comment.kind === 'system') {
      return <div key={comment.commentId} id={comment.commentId} className="app-document-comment-system">{comment.body}</div>;
    }
    const line = agentRunLine(thread, comment);
    // Without run statuses the line needs an agent the viewer can ask, as before.
    const runAgent = mentionedAgentName(comment.body, agentNames) ?? agentName ?? (comment.agentRun ? 'The agent' : null);
    return (
      <div key={comment.commentId} id={comment.commentId} className={isRoot ? 'app-document-comment-root' : 'app-document-comment-reply'}>
        <CommentHeader
          comment={comment}
          canManage={comment.kind === 'agent' ? canDeleteAgentReply(thread, comment, viewerIsOwner) : comment.mine}
          canResolve={isRoot && (viewerIsOwner || comment.mine)}
          shareUrl={shareUrl}
          onEdit={() => setEditingId(comment.commentId)}
          onDelete={() => actions.onDelete(comment.commentId)}
          onResolve={isRoot ? () => actions.onResolve(comment.commentId) : undefined}
        />
        {editingId === comment.commentId ? (
          <DocumentCommentComposer
            placeholder="Edit comment"
            mentionOptions={mentionOptions}
            initialValue={comment.body}
            submitLabel="Save"
            autoFocus
            onCancel={() => setEditingId(null)}
            onSubmit={async (body) => {
              const saved = await actions.onEdit(comment.commentId, body);
              if (saved) setEditingId(null);
              return saved;
            }}
          />
        ) : <CommentBody body={comment.body} names={names} />}
        {line && runAgent ? (
          <AgentRunStatus
            line={line}
            agentName={runAgent}
            onRetry={canReply ? () => actions.onReply(thread.root.commentId, comment.body) : undefined}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="app-document-thread">
      {renderComment(thread.root, true)}
      {thread.replies.map((reply) => renderComment(reply, false))}
      {editedBy ? <div className="app-document-agent-edited">Edited by {editedBy}</div> : null}
      {canReply ? (
        <DocumentCommentComposer
          placeholder={agentName ? `Reply, or @${agentName}` : 'Reply'}
          mentionOptions={mentionOptions}
          offerAgent={canAskEdit ? answeredBy : null}
          onSubmit={(body) => actions.onReply(thread.root.commentId, body)}
        />
      ) : null}
    </div>
  );
}
