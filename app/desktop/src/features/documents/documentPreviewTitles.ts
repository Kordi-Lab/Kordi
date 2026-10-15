import { latestParticipantSpacePreviewMessage } from '@/features/chat/participantConversationState';
import type { Conversation, Message } from '@/kordi-app/types';

import { withUploadedAttachmentId } from './companionDocument';
import { documentShareApiForEnvironment } from './documentShareApi';
import { documentDisplayName, hasCloudDocumentTitle, useDocumentTitle, type DocumentTitleFetch } from './documentTitles';

/** Asks the server for the title of a cloud document none of the readers reported yet. */
export const fetchDocumentTitleFromServer: DocumentTitleFetch = (attachmentId) => documentShareApiForEnvironment().getDocument(attachmentId);

let previewTitleFetch: DocumentTitleFetch = fetchDocumentTitleFromServer;

export function setDocumentPreviewTitleFetchForTests(fetch: DocumentTitleFetch | null) {
  previewTitleFetch = fetch ?? fetchDocumentTitleFromServer;
}

function compactName(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** The cloud Markdown or HTML document a message preview can name: the message's only attachment. */
export function previewDocumentAttachment(message: Pick<Message, 'attachments'> | null | undefined) {
  const attachments = message?.attachments ?? [];
  const only = attachments.length === 1 ? attachments[0] : undefined;
  if (!only) return null;
  const attachment = withUploadedAttachmentId(only);
  const attachmentId = attachment.attachmentId?.trim() ?? '';
  return hasCloudDocumentTitle(attachmentId, attachment.name) ? { attachmentId, name: attachment.name } : null;
}

/** Swaps the file name that ends a preview for the document's title, when the title says more. */
export function documentPreviewText(preview: string, fileName: string, title: string | null | undefined) {
  const name = compactName(fileName);
  const label = documentDisplayName(name, title);
  if (!name || label === name || !preview.endsWith(name)) return preview;
  return `${preview.slice(0, preview.length - name.length)}${label}`;
}

/** The message a sidebar preview was built from: the latest one with preview text in the first conversation that has one. */
function previewMessage(conversations: ReadonlyArray<Conversation | null | undefined>) {
  for (const conversation of conversations) {
    const latest = conversation ? latestParticipantSpacePreviewMessage(conversation) : null;
    if (latest) return latest.message;
  }
  return null;
}

/**
 * A rendered preview of `message` with a renamed document shown under its
 * title. Only rendered previews call it: it subscribes to the title store and
 * fetches a missing title once.
 */
export function useMessageDocumentPreviewText(preview: string, message: Pick<Message, 'attachments'> | null | undefined) {
  const document = previewDocumentAttachment(message);
  const title = useDocumentTitle(document?.attachmentId, document?.name ?? '', previewTitleFetch);
  return document ? documentPreviewText(preview, document.name, title) : preview;
}

/** The same for a sidebar row, whose preview comes from the first of `conversations` with one. */
export function useDocumentPreviewText(preview: string, conversations: ReadonlyArray<Conversation | null | undefined>) {
  return useMessageDocumentPreviewText(preview, previewMessage(conversations));
}
