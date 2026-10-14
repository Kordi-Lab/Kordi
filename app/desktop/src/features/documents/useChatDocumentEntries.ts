import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { composerAttachmentItemFromFile } from '@/features/chat/composerAttachments';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { Message, MessageAttachment, SessionArtifact } from '@/kordi-app/types';

import {
  ADD_DOCUMENT_FAILED,
  blankDocumentFile,
  chatDocumentAttachment,
  chatDocumentNames,
  nextUntitledDocumentName,
  sentChatDocument,
} from './chatDocuments';
import { openAttachmentInCompanion } from './companionDocument';

/** How long a sent document may take to show up in the chat before the entry reports a failure. */
export const SENT_DOCUMENT_TIMEOUT_MS = 45_000;

type PendingDocument = { conversationId: string; path: string; deadline: number };

export type ChatDocumentEntriesOptions = {
  conversationId: string;
  messages: Message[];
  artifacts: SessionArtifact[];
  /** Sends the stored file into the chat as an attachment message; absent where that is not possible. */
  addDocument?: (attachment: AttachmentItem) => Promise<void> | void;
  store?: (file: File) => Promise<AttachmentItem>;
  open?: (attachment: MessageAttachment) => unknown;
  timeoutMs?: number;
};

/**
 * "New document" and "Add file" of the chat Artifacts tab: the file goes into
 * the chat through the composer's attachment send, and its sent copy opens in
 * the document reader once the chat shows it.
 */
export function useChatDocumentEntries({
  conversationId,
  messages,
  artifacts,
  addDocument,
  store = composerAttachmentItemFromFile,
  open = openAttachmentInCompanion,
  timeoutMs = SENT_DOCUMENT_TIMEOUT_MS,
}: ChatDocumentEntriesOptions) {
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingDocument | null>(null);
  const [arrived, setArrived] = useState<{ path: string; attachment: MessageAttachment } | null>(null);
  const [failure, setFailure] = useState<{ conversationId: string } | null>(null);
  const sendingRef = useRef(false);
  const openedRef = useRef<{ path: string; attachment: MessageAttachment } | null>(null);

  const addFile = useCallback(async (file: File) => {
    if (!addDocument || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setFailure(null);
    let path: string | null = null;
    try {
      const attachment = await chatDocumentAttachment(file, store);
      path = attachment.path;
      // Wait from the start: a send can resolve well after the chat shows the document.
      setPending({ conversationId, path, deadline: Date.now() + timeoutMs });
      await addDocument(attachment);
    } catch {
      // A send that fails after its document opened (say, one group member still pending) reports in the chat.
      if (path && openedRef.current?.path === path) return;
      setPending(null);
      setFailure({ conversationId });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [addDocument, conversationId, store, timeoutMs]);

  const createDocument = useCallback(() => (
    addFile(blankDocumentFile(nextUntitledDocumentName(chatDocumentNames(artifacts, messages))))
  ), [addFile, artifacts, messages]);

  // A document sent from another chat is not this chat's to open.
  const awaited = pending?.conversationId === conversationId ? pending : null;
  const sent = useMemo(() => (awaited ? sentChatDocument(messages, awaited.path) : null), [awaited, messages]);
  if (sent && awaited) {
    // The chat has the document: stop waiting, and open it once below.
    setPending(null);
    setArrived({ path: awaited.path, attachment: sent });
  }

  useEffect(() => {
    if (!arrived || openedRef.current === arrived) return;
    openedRef.current = arrived;
    open(arrived.attachment);
  }, [arrived, open]);

  useEffect(() => {
    if (!awaited) return undefined;
    // The send reports its own failure in the chat; this keeps the entry from waiting forever.
    const timer = setTimeout(() => {
      setPending(null);
      setFailure({ conversationId: awaited.conversationId });
    }, Math.max(0, awaited.deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [awaited]);

  return {
    available: Boolean(addDocument),
    busy: sending || Boolean(awaited),
    error: failure?.conversationId === conversationId ? ADD_DOCUMENT_FAILED : null,
    createDocument,
    addFile,
  };
}
