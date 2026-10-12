/** Shapes of the shared documents routes (issue 1741 contract). All field names are camelCase. */

export type DocumentFormat = 'markdown' | 'html';

export type DocumentViewer = 'owner' | 'member' | 'public';

export type DocumentAuthor = {
  accountId: string;
  displayName: string;
  kordiId: string;
  avatarUrl: string | null;
};

export type DocumentAgent = {
  displayName: string;
};

export type DocumentBlockRecord = {
  id: string;
  source: string;
  /** Sanitized HTML rendered by the server. */
  html: string;
};

export type DocumentShare = {
  shareId: string;
  attachmentId: string;
  shareUrl: string;
  deepLink: string;
  accessMode: 'link';
  readersCanAskAgent: boolean;
  createdAt: string;
  revokedAt: string | null;
};

export type DocumentReaction = {
  reactionId: string;
  blockId: string;
  reaction: string;
  actor: {
    accountId: string | null;
    readerKey: string | null;
    displayName: string;
  };
  mine: boolean;
  createdAt: string;
};

export type DocumentComment = {
  commentId: string;
  blockId: string;
  parentCommentId: string | null;
  author: {
    accountId: string | null;
    displayName: string;
    kordiId: string | null;
    avatarUrl: string | null;
  };
  body: string;
  mentionsAgent: boolean;
  mine: boolean;
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
};

export type DocumentViewerCan = {
  share: boolean;
  /** Owner and active members of a Markdown document; never for HTML or public readers. */
  edit?: boolean;
  react: boolean;
  comment: boolean;
  askAgent: boolean;
};

export type DocumentResponse = {
  /** Canonical attachment of the document; forwarded copies resolve to it. */
  attachmentId: string;
  /** The id the document was opened with, when it is a forwarded copy of `attachmentId`. */
  requestedAttachmentId?: string | null;
  title: string;
  fileName: string;
  format: DocumentFormat;
  contentType: string;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  /** Revision of the stored source; a save names the revision it was based on. */
  revision?: number;
  sessionId: string | null;
  sessionTitle: string | null;
  author: DocumentAuthor;
  agent: DocumentAgent | null;
  blocks: DocumentBlockRecord[];
  rawPath: string | null;
  reactions: DocumentReaction[];
  comments: DocumentComment[];
  share: DocumentShare | null;
  viewer: DocumentViewer;
  viewerCan: DocumentViewerCan;
};

export type CreateDocumentShareInput = {
  sessionId?: string;
  readersCanAskAgent?: boolean;
};

export type UpdateDocumentShareInput = {
  readersCanAskAgent: boolean;
};

export type DocumentReactionInput = {
  blockId: string;
  reaction: string;
};

export type DocumentCommentInput = {
  blockId: string;
  body: string;
  parentCommentId?: string;
};

export type UpdateDocumentCommentInput = {
  body?: string;
  resolved?: boolean;
};

export type SaveDocumentContentInput = {
  /** Required for revisioned saves; snapshots from the collaboration room have none. */
  baseRevision?: number;
  source: string;
  /** `snapshot`: written by the room's snapshot writer, no revision check. */
  mode?: 'snapshot';
  /** On a document's first save with stamped ids: index ids (`b3`) to the `k:` ids that replace them. */
  blockIds?: Record<string, string>;
};

/** A save either lands, or the server answers 409 with the current document to rebase onto. */
export type SaveDocumentContentResult =
  | { status: 'saved'; document: DocumentResponse }
  | { status: 'conflict'; document: DocumentResponse };

/** A single-use ticket for the document's collaboration socket. */
export type DocumentCollabTicket = {
  ticket: string;
  /** Socket path, `/v1/cloud/documents/<id>/collab`. */
  url: string;
  /** Single use, bound to the session, the document, and the page origin. */
  expiresInSeconds?: number;
  /** A revisioned save landed outside the room; reconcile changed blocks after sync. */
  staleRevision?: boolean;
};

/** Answer to the seeding request: exactly one caller builds the room from Markdown. */
export type DocumentCollabInit = { initialize: boolean; revision?: number };

/** Payload of the `document.updated` user sync event. */
export type DocumentUpdatedEvent = {
  attachmentId: string;
  revision: number;
  /** `content` for saves, `annotations` for reactions and comments. */
  change?: 'content' | 'annotations';
};

/** Identity a reader without an account writes under on the public routes. */
export type DocumentPublicReader = {
  readerKey: string;
  readerName: string;
};

export type DocumentReactionsResponse = {
  reactions: DocumentReaction[];
};

export type DocumentSharesResponse = {
  shares: DocumentShare[];
};

/** Error code the public routes answer for a revoked or unknown token. */
export const DOCUMENT_LINK_OFF_CODE = 'document_link_off';
