import { useEffect, useRef, useState } from 'react';
import { FilePlus2, Paperclip } from 'lucide-react';

import type { Message, SessionArtifact } from '@/kordi-app/types';

import { ADD_DOCUMENT_ACCEPT, newDocumentBaseName } from './chatDocuments';
import { useDocumentReaderHost } from './documentReaderHost';
import { useChatDocumentEntries, type ChatDocumentEntriesOptions } from './useChatDocumentEntries';

const ENTRY_CLASS = 'app-button-quiet inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium leading-4';
const ICON_ENTRY_CLASS = 'app-button-quiet inline-flex items-center rounded-md p-1 leading-4';

type ChatDocumentEntriesProps = Pick<ChatDocumentEntriesOptions, 'store' | 'open' | 'timeoutMs'> & {
  conversationId: string;
  messages: Message[];
  artifacts: SessionArtifact[];
};

/**
 * The manual entries above the chat Artifacts list. Renders nothing where the
 * chat cannot take an attachment. A new document is sent only once it has a name.
 */
export function ChatDocumentEntries({ conversationId, messages, artifacts, ...overrides }: ChatDocumentEntriesProps) {
  const { addDocument } = useDocumentReaderHost();
  const entries = useChatDocumentEntries({ conversationId, messages, artifacts, addDocument, ...overrides });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const newDocumentRef = useRef<HTMLButtonElement | null>(null);
  // The chat the name field is open for: a name typed for one chat is not another chat's document.
  const [namingFor, setNamingFor] = useState<string | null>(null);
  const naming = namingFor === conversationId;
  if (!entries.available) return null;

  const closeNaming = () => {
    setNamingFor(null);
    newDocumentRef.current?.focus();
  };

  return (
    <div data-chat-document-entries="true" className="shrink-0 pb-3">
      <div className="flex items-center gap-1">
        <button type="button" className={ENTRY_CLASS} disabled={entries.busy} onClick={() => inputRef.current?.click()}>
          <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          Add file
        </button>
        <button
          ref={newDocumentRef}
          type="button"
          className={ICON_ENTRY_CLASS}
          aria-label="New document"
          title="New document"
          aria-expanded={naming}
          disabled={entries.busy}
          onClick={() => setNamingFor(conversationId)}
        >
          <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
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
      {naming ? (
        <NewDocumentNameForm
          onCancel={closeNaming}
          onCreate={(name) => {
            closeNaming();
            void entries.createDocument(name);
          }}
        />
      ) : null}
      {entries.error ? (
        <div role="alert" className="app-error-text mt-2 rounded-[14px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">{entries.error}</div>
      ) : null}
    </div>
  );
}

/** The name field of a new document: Enter or Create sends it, Escape or Cancel drops it. */
function NewDocumentNameForm({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const fieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { fieldRef.current?.focus(); }, []);
  const valid = newDocumentBaseName(name) !== null;
  return (
    <form
      data-new-document-form="true"
      aria-label="New document"
      className="mt-2 flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onCreate(name);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <input
        ref={fieldRef}
        type="text"
        aria-label="Document name"
        placeholder="Document name"
        value={name}
        maxLength={160}
        className="app-input-shell app-flat-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-white outline-none placeholder:text-slate-500"
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" className={ENTRY_CLASS} disabled={!valid}>Create</button>
      <button type="button" className={ENTRY_CLASS} onClick={onCancel}>Cancel</button>
    </form>
  );
}
