import type { DesktopArtifactPreview, MessageAttachment, SessionArtifact } from '@/kordi-app/types';

import { uploadedAttachmentIdForSource } from '@/features/cloud/cloudAttachmentLocalPathCache';

import { documentFormatForPath } from './documentReaderModel';

/** A document shown in the chat companion pane. */
export type CompanionDocument = {
  artifact: SessionArtifact;
  preview: DesktopArtifactPreview | null;
  /** Root the Artifacts tab resolves relative artifact paths against. */
  previewBaseRoot?: string | null;
};

export const COMPANION_DOCUMENT_OPEN_EVENT = 'kordi-companion-document-open';

// A request no chat page took (none mounted at that moment); the next one to mount opens it.
let pendingDocument: CompanionDocument | null = null;

/**
 * Asks the chat page to open a document in its companion pane. Returns false
 * when no chat page is listening, so callers can fall back to their own action.
 */
export function openCompanionDocument(document: CompanionDocument): boolean {
  if (typeof window === 'undefined') return false;
  const event = new window.CustomEvent<CompanionDocument>(COMPANION_DOCUMENT_OPEN_EVENT, { detail: document, cancelable: true });
  return !window.dispatchEvent(event);
}

/** The request no chat page took yet, once. */
export function takePendingCompanionDocument() {
  const document = pendingDocument;
  pendingDocument = null;
  return document;
}

/** Opens a Markdown or HTML artifact in the companion pane; other artifacts stay inline. */
export function openArtifactInCompanion(artifact: SessionArtifact, previewBaseRoot?: string | null): boolean {
  if (!documentFormatForPath(artifact.path)) return false;
  return openCompanionDocument({ artifact, preview: null, previewBaseRoot: previewBaseRoot ?? null });
}

/** A Markdown or HTML file with a cloud copy: it opens in the document reader, never as a download. */
export function isReaderAttachment(attachment: Pick<MessageAttachment, 'attachmentId' | 'name'>) {
  return Boolean(attachment.attachmentId?.trim() && documentFormatForPath(attachment.name));
}

export type UploadedAttachmentId = (sourcePath: string) => string | null;

/**
 * A group send shows its own local row (`cloud-group-ui`), whose attachment
 * points at the stored file and has no cloud id, until the server echo
 * replaces it, which can come late or not at all. The id this window uploaded
 * the file under fills the gap.
 */
export function withUploadedAttachmentId(
  attachment: MessageAttachment,
  uploadedId: UploadedAttachmentId = uploadedAttachmentIdForSource,
): MessageAttachment {
  if (attachment.attachmentId?.trim()) return attachment;
  const localPath = attachment.localPath?.trim();
  const attachmentId = localPath ? uploadedId(localPath) : null;
  return attachmentId ? { ...attachment, attachmentId } : attachment;
}

function attachmentDocument(attachment: MessageAttachment): CompanionDocument {
  const attachmentId = attachment.attachmentId?.trim() ?? '';
  return {
    artifact: {
      id: `attachment:${attachmentId}`,
      path: attachment.localPath?.trim() || attachment.name,
      name: attachment.name,
      kind: 'document',
      summary: '',
      attachmentId,
    },
    preview: null,
    previewBaseRoot: null,
  };
}

/**
 * The one route for opening or downloading a file attachment: Markdown and
 * HTML with a cloud id open in the chat's document pane and the caller stops
 * (returns true). When no chat page is listening at that instant, the request
 * waits for the next one rather than falling back to a download. Other files
 * return false and keep their open or download action.
 */
export function openAttachmentInCompanion(sent: MessageAttachment): boolean {
  const attachment = withUploadedAttachmentId(sent);
  if (!isReaderAttachment(attachment)) return false;
  const document = attachmentDocument(attachment);
  if (!openCompanionDocument(document)) pendingDocument = document;
  return true;
}
