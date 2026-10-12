import type {
  DocumentCollabInit,
  DocumentCollabTicket,
  SaveDocumentContentInput,
  SaveDocumentContentResult,
  CreateDocumentShareInput,
  DocumentComment,
  DocumentCommentInput,
  DocumentPublicReader,
  DocumentReactionInput,
  DocumentReactionsResponse,
  DocumentResponse,
  DocumentShare,
  DocumentSharesResponse,
  UpdateDocumentCommentInput,
  UpdateDocumentShareInput,
} from './documentShareTypes';

export type CloudRequestClient = {
  request<TResponse>(path: string, init: RequestInit, fallbackMessage: string): Promise<TResponse>;
};

const segment = encodeURIComponent;

function authorized(token: string, method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method, headers: { authorization: `Bearer ${token}` } }
    : {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      };
}

function anonymous(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function getCloudDocument(client: CloudRequestClient, token: string, attachmentId: string): Promise<DocumentResponse> {
  return client.request(`/v1/cloud/documents/${segment(attachmentId)}`, authorized(token, 'GET'), 'Could not open the document.');
}

export function createCloudDocumentShare(
  client: CloudRequestClient,
  token: string,
  attachmentId: string,
  input: CreateDocumentShareInput = {},
): Promise<DocumentShare> {
  return client.request(`/v1/cloud/documents/${segment(attachmentId)}/shares`, authorized(token, 'POST', input), 'Could not turn on the link.');
}

export async function listCloudDocumentShares(client: CloudRequestClient, token: string, attachmentId: string): Promise<DocumentShare[]> {
  const response = await client.request<DocumentSharesResponse>(
    `/v1/cloud/documents/${segment(attachmentId)}/shares`,
    authorized(token, 'GET'),
    'Could not load the link.',
  );
  return response?.shares ?? [];
}

export function updateCloudDocumentShare(
  client: CloudRequestClient,
  token: string,
  shareId: string,
  input: UpdateDocumentShareInput,
): Promise<DocumentShare> {
  return client.request(`/v1/cloud/documents/shares/${segment(shareId)}`, authorized(token, 'PATCH', input), 'Could not update the link.');
}

export async function revokeCloudDocumentShare(client: CloudRequestClient, token: string, shareId: string): Promise<void> {
  await client.request(`/v1/cloud/documents/shares/${segment(shareId)}`, authorized(token, 'DELETE'), 'Could not turn off the link.');
}

export async function toggleCloudDocumentReaction(
  client: CloudRequestClient,
  token: string,
  attachmentId: string,
  input: DocumentReactionInput,
) {
  const response = await client.request<DocumentReactionsResponse>(
    `/v1/cloud/documents/${segment(attachmentId)}/reactions`,
    authorized(token, 'POST', input),
    'Could not react.',
  );
  return response?.reactions ?? [];
}

export function createCloudDocumentComment(
  client: CloudRequestClient,
  token: string,
  attachmentId: string,
  input: DocumentCommentInput,
): Promise<DocumentComment> {
  return client.request(`/v1/cloud/documents/${segment(attachmentId)}/comments`, authorized(token, 'POST', input), 'Could not post the comment.');
}

export function updateCloudDocumentComment(
  client: CloudRequestClient,
  token: string,
  commentId: string,
  input: UpdateDocumentCommentInput,
): Promise<DocumentComment> {
  return client.request(`/v1/cloud/documents/comments/${segment(commentId)}`, authorized(token, 'PATCH', input), 'Could not update the comment.');
}

export async function deleteCloudDocumentComment(client: CloudRequestClient, token: string, commentId: string): Promise<void> {
  await client.request(`/v1/cloud/documents/comments/${segment(commentId)}`, authorized(token, 'DELETE'), 'Could not delete the comment.');
}

/**
 * Points a forwarded copy at the document it was forwarded from, so both show
 * one set of reactions, comments, edits, and links. Call after the copy's
 * upload finalizes and before the message is sent.
 */
export function linkCloudDocumentSource(
  client: CloudRequestClient,
  token: string,
  copyAttachmentId: string,
  sourceAttachmentId: string,
): Promise<DocumentResponse> {
  return client.request(
    `/v1/cloud/documents/${segment(copyAttachmentId)}/source`,
    authorized(token, 'POST', { sourceAttachmentId }),
    'Could not link the forwarded document.',
  );
}

export function getPublicDocument(client: CloudRequestClient, shareToken: string): Promise<DocumentResponse> {
  return client.request(`/v1/cloud/public/documents/${segment(shareToken)}`, anonymous('GET'), 'This link is off');
}

export async function togglePublicDocumentReaction(
  client: CloudRequestClient,
  shareToken: string,
  input: DocumentReactionInput & DocumentPublicReader,
) {
  const response = await client.request<DocumentReactionsResponse>(
    `/v1/cloud/public/documents/${segment(shareToken)}/reactions`,
    anonymous('POST', input),
    'Could not react.',
  );
  return response?.reactions ?? [];
}

export function createPublicDocumentComment(
  client: CloudRequestClient,
  shareToken: string,
  input: DocumentCommentInput & DocumentPublicReader,
): Promise<DocumentComment> {
  return client.request(
    `/v1/cloud/public/documents/${segment(shareToken)}/comments`,
    anonymous('POST', input),
    'Could not post the comment.',
  );
}

export type CloudTextFetch = (url: string, init: RequestInit) => Promise<Response>;

/** HTML bytes of an uploaded document. The JSON request client cannot return text, so this uses the same transport directly. */
export async function getCloudDocumentRaw(
  fetchImpl: CloudTextFetch,
  baseUrl: string,
  token: string,
  attachmentId: string,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/v1/cloud/documents/${segment(attachmentId)}/raw`, authorized(token, 'GET'));
  if (!response.ok) throw new Error('Could not open the document.');
  return response.text();
}

function documentFromBody(body: unknown): DocumentResponse | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { attachmentId?: unknown; document?: unknown };
  if (typeof record.attachmentId === 'string') return body as DocumentResponse;
  return record.document && typeof record.document === 'object' ? record.document as DocumentResponse : null;
}

/**
 * Saves the whole Markdown source. A 409 carries the current document to rebase onto,
 * which the JSON request client would drop, so this reads the response itself.
 */
export async function saveCloudDocumentContent(
  fetchImpl: CloudTextFetch,
  baseUrl: string,
  token: string,
  attachmentId: string,
  input: SaveDocumentContentInput,
): Promise<SaveDocumentContentResult> {
  const response = await fetchImpl(`${baseUrl}/v1/cloud/documents/${segment(attachmentId)}/content`, authorized(token, 'PUT', input));
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const document = documentFromBody(body);
  if (response.status === 409 && document) return { status: 'conflict', document };
  if (!response.ok || !document) {
    throw new Error(response.status === 413 ? 'This document is too large to save.' : response.status === 403 ? 'You can\'t edit this document.' : 'Could not save the document.');
  }
  return { status: 'saved', document };
}

export function requestCloudDocumentCollabTicket(client: CloudRequestClient, token: string, attachmentId: string): Promise<DocumentCollabTicket> {
  return client.request(`/v1/cloud/documents/${segment(attachmentId)}/collab/ticket`, authorized(token, 'POST', {}), 'Could not join the document.');
}

export function initCloudDocumentCollab(client: CloudRequestClient, token: string, attachmentId: string): Promise<DocumentCollabInit> {
  return client.request(`/v1/cloud/documents/${segment(attachmentId)}/collab/init`, authorized(token, 'POST', {}), 'Could not prepare the document.');
}
