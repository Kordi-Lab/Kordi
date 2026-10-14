import type { AttachmentItem } from '@/features/chat/composerController.types';
import { cachedCloudAttachmentLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import type { Message, MessageAttachment, SessionArtifact } from '@/kordi-app/types';

import { isReaderAttachment } from './companionDocument';
import { documentContentType, documentFileName, documentFormatForPath } from './documentReaderModel';

/** What the file picker of "Add file" offers. */
export const ADD_DOCUMENT_ACCEPT = '.md,.markdown,.html,.htm';

export const ADD_DOCUMENT_FAILED = 'Could not add the document.';

/**
 * A new document starts as one line break: an empty Markdown body that the
 * editor opens as a single empty paragraph, without a zero-byte upload.
 */
export const BLANK_DOCUMENT_BODY = '\n';

const UNTITLED = 'Untitled';

/** `Untitled.md`, then `Untitled 2.md`, and so on past the names the chat already has. */
export function nextUntitledDocumentName(existingNames: Iterable<string>): string {
  const taken = new Set([...existingNames].map((name) => name.trim().toLowerCase()));
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? `${UNTITLED}.md` : `${UNTITLED} ${index}.md`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Content type of a file "Add file" accepts, or null for any other file. */
export function addableDocumentContentType(name: string): 'text/markdown' | 'text/html' | null {
  return documentFormatForPath(name) ? documentContentType(name) : null;
}

export function blankDocumentFile(name: string): File {
  return new File([BLANK_DOCUMENT_BODY], name, { type: 'text/markdown' });
}

function messageAttachments(messages: Message[]): Array<{ message: Message; attachment: MessageAttachment }> {
  return messages.flatMap((message) => (message.attachments ?? []).map((attachment) => ({ message, attachment })));
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
export function chatDocumentArtifacts(messages: Message[]): SessionArtifact[] {
  const byAttachment = new Map<string, SessionArtifact>();
  for (const { message, attachment } of messageAttachments(messages)) {
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
export function withChatDocumentArtifacts(artifacts: SessionArtifact[], messages: Message[]): SessionArtifact[] {
  const listed = new Set(artifacts.map((artifact) => artifact.attachmentId?.trim()).filter(Boolean));
  const added = chatDocumentArtifacts(messages).filter((artifact) => !listed.has(artifact.attachmentId ?? ''));
  return added.length > 0 ? [...added, ...artifacts] : artifacts;
}

/**
 * The sent copy of a file stored at `path`: the attachment of a loaded message
 * that has a cloud id and came from that file on this Mac.
 */
export function sentChatDocument(
  messages: Message[],
  path: string,
  cachedPath: (attachmentId: string) => string | null = cachedCloudAttachmentLocalPath,
): MessageAttachment | null {
  const sent = messageAttachments(messages).reverse().find(({ attachment }) => {
    const attachmentId = attachment.attachmentId?.trim();
    if (!attachmentId || !isReaderAttachment(attachment)) return false;
    return attachment.localPath?.trim() === path || cachedPath(attachmentId) === path;
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
