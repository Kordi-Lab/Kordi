import type { DesktopArtifactPreview, MessageAttachment, SessionArtifact } from '@/kordi-app/types';

import { documentFormatForPath } from './documentReaderModel';

/** A document shown in the chat companion pane. */
export type CompanionDocument = {
  artifact: SessionArtifact;
  preview: DesktopArtifactPreview | null;
  /** Root the Artifacts tab resolves relative artifact paths against. */
  previewBaseRoot?: string | null;
};

export const COMPANION_DOCUMENT_OPEN_EVENT = 'kordi-companion-document-open';

/**
 * Asks the chat page to open a document in its companion pane. Returns false
 * when no chat page is listening, so callers can fall back to their own action.
 */
export function openCompanionDocument(document: CompanionDocument): boolean {
  if (typeof window === 'undefined') return false;
  const event = new window.CustomEvent<CompanionDocument>(COMPANION_DOCUMENT_OPEN_EVENT, { detail: document, cancelable: true });
  return !window.dispatchEvent(event);
}

/** Opens a Markdown or HTML artifact in the companion pane; other artifacts stay inline. */
export function openArtifactInCompanion(artifact: SessionArtifact, previewBaseRoot?: string | null): boolean {
  if (!documentFormatForPath(artifact.path)) return false;
  return openCompanionDocument({ artifact, preview: null, previewBaseRoot: previewBaseRoot ?? null });
}

/** Opens a Markdown or HTML cloud attachment from the transcript in the companion pane. */
export function openAttachmentInCompanion(attachment: MessageAttachment): boolean {
  const attachmentId = attachment.attachmentId?.trim();
  if (!attachmentId || !documentFormatForPath(attachment.name)) return false;
  return openCompanionDocument({
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
  });
}
