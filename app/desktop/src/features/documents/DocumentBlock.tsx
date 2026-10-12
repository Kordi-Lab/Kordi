import { memo } from 'react';

import { DocumentCommentComposer, DocumentThread, type DocumentMentionOption, type DocumentThreadActions } from './DocumentComments';
import type { CommentThread, ReactionPill } from './documentReaderModel';

export type DocumentBlockThreadProps = {
  agentName: string | null;
  mentionOptions: DocumentMentionOption[];
  viewerIsOwner: boolean;
  canComment: boolean;
  canReact: boolean;
  shareUrl: string | null;
  actions: DocumentThreadActions;
  onToggleReaction: (blockId: string, reaction: string) => void;
  onPostComment: (blockId: string, body: string) => Promise<boolean>;
  onCancelComposer: () => void;
};

type AnnotationProps = {
  /** Block id the server knows (index `b3` or stamped `k:…`); reactions and comments post to it. */
  id: string;
  pills: ReactionPill[];
  threads: CommentThread[];
  composing: boolean;
  shared: DocumentBlockThreadProps;
};

/** Reaction pills, comment threads, and the new-comment field under one block. */
export const DocumentBlockAnnotations = memo(function DocumentBlockAnnotations({ id, pills, threads, composing, shared }: AnnotationProps) {
  return (
    <>
      {pills.length > 0 ? (
        <div className="app-document-reactions">
          {pills.map((pill) => (
            <button
              key={pill.reaction}
              type="button"
              className="app-document-reaction"
              aria-pressed={pill.mine}
              aria-label={`${pill.reaction} ${pill.count}`}
              disabled={!shared.canReact}
              onClick={() => shared.onToggleReaction(id, pill.reaction)}
            >
              <span aria-hidden="true">{pill.reaction}</span>
              <span>{pill.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {threads.map((thread) => (
        <DocumentThread
          key={thread.root.commentId}
          thread={thread}
          agentName={shared.agentName}
          mentionOptions={shared.mentionOptions}
          viewerIsOwner={shared.viewerIsOwner}
          canReply={shared.canComment}
          shareUrl={shared.shareUrl}
          actions={shared.actions}
        />
      ))}
      {composing ? (
        <div className="app-document-thread is-new">
          <DocumentCommentComposer
            placeholder={shared.agentName ? `Add a comment, or @${shared.agentName}` : 'Add a comment'}
            mentionOptions={shared.mentionOptions}
            autoFocus
            onCancel={shared.onCancelComposer}
            onSubmit={async (body) => {
              const posted = await shared.onPostComment(id, body);
              if (posted) shared.onCancelComposer();
              return posted;
            }}
          />
        </div>
      ) : null}
    </>
  );
});
