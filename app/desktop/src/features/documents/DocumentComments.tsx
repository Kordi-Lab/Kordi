import { AtSign, Check, MoreHorizontal } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

import {
  appendMention,
  formatCommentTime,
  mentionSegments,
  threadAwaitsAgent,
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
  onSubmit,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  mentionOptions: DocumentMentionOption[];
  initialValue?: string;
  submitLabel?: string;
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
      className="app-document-composer"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
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
  canResolve,
  shareUrl,
  onEdit,
  onDelete,
  onResolve,
}: {
  comment: DocumentComment;
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
  return (
    <div className="app-document-comment-head" ref={menuRef}>
      <IdentityAvatar kind="human" seed={comment.author.accountId || comment.author.displayName} name={comment.author.displayName} imageUrl={comment.author.avatarUrl} className="app-document-avatar-small" />
      <div className="app-document-comment-name">
        {comment.author.displayName}
        <span>{formatCommentTime(comment.createdAt)}</span>
      </div>
      {comment.mine ? (
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
          <button type="button" role="menuitem" className="app-document-menu-row" onClick={() => { onEdit(); close(); }}>
            <span className="app-document-menu-label">Edit</span>
          </button>
          <hr />
          <button type="button" role="menuitem" className="app-document-menu-row is-danger" onClick={() => { onDelete(); close(); }}>
            <span className="app-document-menu-label">Delete comment</span>
          </button>
        </div>
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
  shareUrl,
  actions,
}: {
  thread: CommentThread;
  agentName: string | null;
  mentionOptions: DocumentMentionOption[];
  viewerIsOwner: boolean;
  canReply: boolean;
  shareUrl: string | null;
  actions: DocumentThreadActions;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const names = mentionOptions.map((option) => option.name);
  const renderComment = (comment: DocumentComment, isRoot: boolean) => (
    <div key={comment.commentId} id={comment.commentId} className={isRoot ? 'app-document-comment-root' : 'app-document-comment-reply'}>
      <CommentHeader
        comment={comment}
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
    </div>
  );

  return (
    <div className="app-document-thread">
      {renderComment(thread.root, true)}
      {thread.replies.map((reply) => renderComment(reply, false))}
      {agentName && threadAwaitsAgent(thread) ? (
        <div className="app-document-agent-working" role="status">
          <span className="app-document-working-dots" aria-hidden="true"><i /><i /><i /></span>
          {agentName} is working
        </div>
      ) : null}
      {canReply ? (
        <DocumentCommentComposer
          placeholder={agentName ? `Reply, or @${agentName}` : 'Reply'}
          mentionOptions={mentionOptions}
          onSubmit={(body) => actions.onReply(thread.root.commentId, body)}
        />
      ) : null}
    </div>
  );
}
