import { useRef } from 'react';
import { FilePlus2, Paperclip } from 'lucide-react';

import type { Message, SessionArtifact } from '@/kordi-app/types';

import { ADD_DOCUMENT_ACCEPT } from './chatDocuments';
import { useDocumentReaderHost } from './documentReaderHost';
import { useChatDocumentEntries, type ChatDocumentEntriesOptions } from './useChatDocumentEntries';

const ENTRY_CLASS = 'app-button-quiet inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium leading-4';

type ChatDocumentEntriesProps = Pick<ChatDocumentEntriesOptions, 'store' | 'open' | 'timeoutMs'> & {
  conversationId: string;
  messages: Message[];
  artifacts: SessionArtifact[];
};

/** The manual entries above the chat Artifacts list. Renders nothing where the chat cannot take an attachment. */
export function ChatDocumentEntries({ conversationId, messages, artifacts, ...overrides }: ChatDocumentEntriesProps) {
  const { addDocument } = useDocumentReaderHost();
  const entries = useChatDocumentEntries({ conversationId, messages, artifacts, addDocument, ...overrides });
  const inputRef = useRef<HTMLInputElement | null>(null);
  if (!entries.available) return null;

  return (
    <div data-chat-document-entries="true" className="shrink-0 pb-3">
      <div className="flex items-center gap-1">
        <button type="button" className={ENTRY_CLASS} disabled={entries.busy} onClick={() => { void entries.createDocument(); }}>
          <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
          New document
        </button>
        <button type="button" className={ENTRY_CLASS} disabled={entries.busy} onClick={() => inputRef.current?.click()}>
          <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          Add file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ADD_DOCUMENT_ACCEPT}
          className="hidden"
          aria-label="Add file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void entries.addFile(file);
            event.currentTarget.value = '';
          }}
        />
      </div>
      {entries.error ? (
        <div role="alert" className="app-error-text mt-2 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">{entries.error}</div>
      ) : null}
    </div>
  );
}
