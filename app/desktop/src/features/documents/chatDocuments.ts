import type { AttachmentItem } from '@/features/chat/composerController.types';
import { uploadedAttachmentIdForSource } from '@/features/cloud/cloudAttachmentLocalPathCache';
import type { Message, MessageAttachment, SessionArtifact } from '@/kordi-app/types';

import { isReaderAttachment, withUploadedAttachmentId, type UploadedAttachmentId } from './companionDocument';
import { documentContentType, documentFileName, documentFormatForPath } from './documentReaderModel';

/** What the file picker of "Add file" offers. */
export const ADD_DOCUMENT_ACCEPT = '.md,.markdown,.html,.htm';

export const ADD_DOCUMENT_FAILED = 'Could not add the document.';

/** Longest name a new document takes, before its extension. */
const DOCUMENT_NAME_MAX = 120;

/** Generated names a new document never takes, even when typed. */
const PLACEHOLDER_NAME = /^untitled(?: \d+)?$/i;

/**
 * The name a new document gets from what was typed: trimmed, without a
 * Markdown extension or path separators. Null for an empty or placeholder name.
 */
export function newDocumentBaseName(input: string): string | null {
  const name = input
    .replace(/[\\/:\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.(?:md|markdown)$/i, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, DOCUMENT_NAME_MAX)
    .trim();
  return name && !PLACEHOLDER_NAME.test(name) ? name : null;
}

/** `<name>.md`, then `<name> 2.md`, and so on past the names the chat already has. */
export function nextDocumentFileName(baseName: string, existingNames: Iterable<string>): string {
  const taken = new Set([...existingNames].map((name) => name.trim().toLowerCase()));
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? `${baseName}.md` : `${baseName} ${index}.md`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** A new Markdown document that starts with its name as the first heading, or null for a name it cannot take. */
export function newDocumentFile(input: string, existingNames: Iterable<string>): File | null {
  const baseName = newDocumentBaseName(input);
  if (!baseName) return null;
  return new File([`# ${baseName}\n`], nextDocumentFileName(baseName, existingNames), { type: 'text/markdown' });
}

/** Content type of a file "Add file" accepts, or null for any other file. */
export function addableDocumentContentType(name: string): 'text/markdown' | 'text/html' | null {
  return documentFormatForPath(name) ? documentContentType(name) : null;
}

function messageAttachments(
  messages: Message[],
  uploadedId: UploadedAttachmentId = uploadedAttachmentIdForSource,
): Array<{ message: Message; attachment: MessageAttachment }> {
  return messages.flatMap((message) => (message.attachments ?? []).map((attachment) => ({
    message,
    attachment: withUploadedAttachmentId(attachment, uploadedId),
  })));
}

/** File names of the documents the chat already has, listed or sent. */
export function chatDocumentNames(artifacts: SessionArtifact[], messages: Message[]): string[] {
  return [
    ...artifacts.map((artifact) => artifact.name?.trim() || documentFileName(artifact.path)),
    ...messageAttachments(messages).map(({ attachment }) => attachment.name),
  ];
}

/**
 * Markdown and HTML attachments of the loaded messages as Artifacts rows,
 * newest first. Ids match the ones transcript attachments open under, so a
 * document has one companion tab however it was opened.
 */
export function chatDocumentArtifacts(messages: Message[], uploadedId?: UploadedAttachmentId): SessionArtifact[] {
  const byAttachment = new Map<string, SessionArtifact>();
  for (const { message, attachment } of messageAttachments(messages, uploadedId)) {
    const attachmentId = attachment.attachmentId?.trim() ?? '';
    if (!attachmentId || !isReaderAttachment(attachment)) continue;
    byAttachment.set(attachmentId, {
      id: `attachment:${attachmentId}`,
      path: attachment.name,
      name: attachment.name,
      kind: 'document',
      category: 'artifact',
      summary: '',
      attachmentId,
      ...(message.time ? { timeLabel: message.time } : {}),
    });
  }
  return [...byAttachment.values()].reverse();
}

/** The Artifacts list plus the chat's document attachments it does not list yet. */
export function withChatDocumentArtifacts(artifacts: SessionArtifact[], messages: Message[], uploadedId?: UploadedAttachmentId): SessionArtifact[] {
  const listed = new Set(artifacts.map((artifact) => artifact.attachmentId?.trim()).filter(Boolean));
  const added = chatDocumentArtifacts(messages, uploadedId).filter((artifact) => !listed.has(artifact.attachmentId ?? ''));
  return added.length > 0 ? [...added, ...artifacts] : artifacts;
}

/**
 * The sent copy of a file stored at `path`: the attachment of a loaded message
 * with the cloud id this file was uploaded under. A delivered message points at
 * the upload's cached copy, not at `path`, so the id is the match.
 */
export function sentChatDocument(
  messages: Message[],
  path: string,
  uploadedId: UploadedAttachmentId = uploadedAttachmentIdForSource,
): MessageAttachment | null {
  const expectedId = uploadedId(path);
  const sent = messageAttachments(messages, uploadedId).reverse().find(({ attachment }) => {
    const attachmentId = attachment.attachmentId?.trim();
    if (!attachmentId || !isReaderAttachment(attachment)) return false;
    return attachmentId === expectedId || attachment.localPath?.trim() === path;
  });
  return sent?.attachment ?? null;
}

/** Stores the file on this Mac as a composer attachment, typed as the document it is. */
export async function chatDocumentAttachment(
  file: File,
  store: (file: File) => Promise<AttachmentItem>,
): Promise<AttachmentItem> {
  const contentType = addableDocumentContentType(file.name);
  if (!contentType) throw new Error(ADD_DOCUMENT_FAILED);
  // Pickers often leave Markdown untyped; the server reads the format from the content type.
  const typed = file.type === contentType ? file : new File([file], file.name, { type: contentType });
  return store(typed);
}
