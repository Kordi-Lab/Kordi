import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { loadSession, type StoredSession } from '@/features/cloud/session';
import { cloudFetchImpl } from '@/features/cloud/cloudTransport';
import { uploadDesktopCloudAttachment } from '@/lib/cloudAttachmentUpload';

import {
  createCloudDocumentComment,
  createCloudDocumentShare,
  createPublicDocumentComment,
  deleteCloudDocumentComment,
  getCloudDocument,
  getCloudDocumentRaw,
  getPublicDocument,
  listCloudDocumentShares,
  revokeCloudDocumentShare,
  toggleCloudDocumentReaction,
  togglePublicDocumentReaction,
  updateCloudDocumentComment,
  updateCloudDocumentShare,
  type CloudRequestClient,
  type CloudTextFetch,
} from './documentShareClient';
import type {
  CreateDocumentShareInput,
  DocumentComment,
  DocumentCommentInput,
  DocumentPublicReader,
  DocumentReaction,
  DocumentReactionInput,
  DocumentResponse,
  DocumentShare,
  UpdateDocumentCommentInput,
  UpdateDocumentShareInput,
} from './documentShareTypes';

/** Where reactions and comments go: the attachment for signed-in viewers, the share token for link readers. */
export type DocumentWriteTarget =
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'public'; token: string; reader: DocumentPublicReader };

export type DocumentUploadResult = { attachmentId: string; sizeBytes: number | null };

/** What the document reader needs from the server. Tests and the visual page pass an in-memory version. */
export type DocumentShareApi = {
  getDocument(attachmentId: string): Promise<DocumentResponse>;
  getPublicDocument(token: string): Promise<DocumentResponse>;
  /** HTML of an uploaded `html` document for its owner or members. */
  getDocumentRaw(attachmentId: string): Promise<string>;
  /** HTML behind a public `rawPath` such as `/d/<token>/raw`; no sign-in. */
  getPublicDocumentRaw(rawPath: string): Promise<string>;
  listShares(attachmentId: string): Promise<DocumentShare[]>;
  createShare(attachmentId: string, input?: CreateDocumentShareInput): Promise<DocumentShare>;
  updateShare(shareId: string, input: UpdateDocumentShareInput): Promise<DocumentShare>;
  revokeShare(shareId: string): Promise<void>;
  toggleReaction(target: DocumentWriteTarget, input: DocumentReactionInput): Promise<DocumentReaction[]>;
  createComment(target: DocumentWriteTarget, input: DocumentCommentInput): Promise<DocumentComment>;
  updateComment(commentId: string, input: UpdateDocumentCommentInput): Promise<DocumentComment>;
  deleteComment(commentId: string): Promise<void>;
  /** Uploads a file on this Mac through the attachment initiate, upload, finalize path. */
  uploadDocument(path: string, contentType: string | null): Promise<DocumentUploadResult>;
  /** Absolute URL for a public `rawPath` such as `/d/<token>/raw`. */
  rawDocumentUrl(rawPath: string): string;
};

export type DocumentShareApiOptions = {
  client?: CloudRequestClient;
  loadSession?: () => Promise<StoredSession | null>;
  baseUrl?: () => string;
  upload?: typeof uploadDesktopCloudAttachment;
  fetchImpl?: CloudTextFetch;
};

export const SIGN_IN_TO_SHARE = 'Sign in to Kordi first.';

export function createDocumentShareApi(options: DocumentShareApiOptions = {}): DocumentShareApi {
  const client = options.client ?? defaultCloudAuthClient();
  const session = options.loadSession ?? loadSession;
  const baseUrl = options.baseUrl ?? (() => cloudApiBaseUrl());
  const upload = options.upload ?? uploadDesktopCloudAttachment;
  const fetchText: CloudTextFetch = options.fetchImpl ?? ((url, init) => cloudFetchImpl()(url, init));
  const withToken = async <T>(run: (token: string, accountId: string) => Promise<T>): Promise<T> => {
    const stored = await session();
    if (!stored?.token) throw new Error(SIGN_IN_TO_SHARE);
    return run(stored.token, stored.accountId);
  };

  return {
    getDocument: (attachmentId) => withToken((token) => getCloudDocument(client, token, attachmentId)),
    getPublicDocument: (token) => getPublicDocument(client, token),
    getPublicDocumentRaw: async (rawPath) => {
      const response = await fetchText(`${baseUrl()}${rawPath}`, { method: 'GET' });
      if (!response.ok) throw new Error('This link is off');
      return response.text();
    },
    getDocumentRaw: (attachmentId) => withToken((token) => getCloudDocumentRaw(fetchText, baseUrl(), token, attachmentId)),
    listShares: (attachmentId) => withToken((token) => listCloudDocumentShares(client, token, attachmentId)),
    createShare: (attachmentId, input) => withToken((token) => createCloudDocumentShare(client, token, attachmentId, input)),
    updateShare: (shareId, input) => withToken((token) => updateCloudDocumentShare(client, token, shareId, input)),
    revokeShare: (shareId) => withToken((token) => revokeCloudDocumentShare(client, token, shareId)),
    toggleReaction: (target, input) => (target.kind === 'public'
      ? togglePublicDocumentReaction(client, target.token, { ...input, ...target.reader })
      : withToken((token) => toggleCloudDocumentReaction(client, token, target.attachmentId, input))),
    createComment: (target, input) => (target.kind === 'public'
      ? createPublicDocumentComment(client, target.token, { ...input, ...target.reader })
      : withToken((token) => createCloudDocumentComment(client, token, target.attachmentId, input))),
    updateComment: (commentId, input) => withToken((token) => updateCloudDocumentComment(client, token, commentId, input)),
    deleteComment: (commentId) => withToken((token) => deleteCloudDocumentComment(client, token, commentId)),
    uploadDocument: (path, contentType) => withToken(async (_token, accountId) => {
      const requestId = `document-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await upload(requestId, path, contentType, accountId);
      return { attachmentId: result.attachmentId, sizeBytes: result.sizeBytes };
    }),
    rawDocumentUrl: (rawPath) => `${baseUrl()}${rawPath}`,
  };
}

let environmentApi: DocumentShareApi | null = null;

export function documentShareApiForEnvironment(): DocumentShareApi {
  environmentApi ??= createDocumentShareApi();
  return environmentApi;
}

const READER_KEY_STORAGE = 'kordi.documentReaderKey.v1';

/** Opaque key (16 to 64 URL-safe characters) that lets a link reader toggle their own reactions. */
export function documentReaderKey(storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage()): string {
  const stored = storage?.getItem(READER_KEY_STORAGE) ?? '';
  if (/^[A-Za-z0-9_-]{16,64}$/.test(stored)) return stored;
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const next = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
  try {
    storage?.setItem(READER_KEY_STORAGE, next);
  } catch {
    // The key stays valid for this window even when storage is unavailable.
  }
  return next;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
