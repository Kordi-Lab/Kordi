import { useId, useRef } from 'react';
import { FilePlus2, FolderOpen, Paperclip } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/ErrorLine';
import type { Message, SessionArtifact } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

import { ADD_DOCUMENT_ACCEPT } from './chatDocuments';
import { useDocumentReaderHost } from './documentReaderHost';
import { useChatDocumentEntries, type ChatDocumentEntriesOptions } from './useChatDocumentEntries';

// The same buttons as the Memory tab: quiet above a list, outlined in the empty state. Above the
// list, 7px of padding inside the 1px border puts the first icon on the list's text edge.
const LIST_ENTRY_CLASS = 'h-8 gap-1.5 rounded-lg px-[7px] text-[12px]';
const EMPTY_ENTRY_CLASS = 'h-8 gap-1.5 rounded-lg px-3 text-[12px]';
const FORMAT_HELP = 'Markdown and HTML documents';

type ChatDocumentEntriesProps = Pick<ChatDocumentEntriesOptions, 'store' | 'open' | 'timeoutMs'> & {
  conversationId: string;
  messages: Message[];
  artifacts: SessionArtifact[];
  /** Shown in the centered empty state while the chat has no artifacts. */
  emptyLabel?: string;
};

/**
 * "New document" and "Add file" of the chat Artifacts tab. With artifacts they sit in a row above
 * the list, their first icon on the list's text edge; without any, the tab shows a centered icon,
 * one line, and the two buttons, like the Memory tab. The buttons are left out where the chat
 * cannot take an attachment. One instance serves both states, so a document sent from the empty
 * state still opens once the chat lists it.
 */
export function ChatDocumentEntries({ conversationId, messages, artifacts, emptyLabel = 'No artifacts yet', ...overrides }: ChatDocumentEntriesProps) {
  const { addDocument } = useDocumentReaderHost();
  const entries = useChatDocumentEntries({ conversationId, messages, artifacts, addDocument, ...overrides });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formatHelpId = useId();
  const empty = artifacts.length === 0;
  if (!empty && !entries.available) return null;

  const buttonClass = empty ? EMPTY_ENTRY_CLASS : LIST_ENTRY_CLASS;
  const variant = empty ? 'outline' : 'quiet';
  const actions = entries.available ? (
    <div data-chat-document-entries="true" className={cn('flex items-center', empty ? 'mt-4 gap-2' : '-ml-2 min-h-8 gap-1')}>
      <Button type="button" variant={variant} className={buttonClass} disabled={entries.busy} onClick={() => { void entries.createDocument(); }}>
        <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
        New document
      </Button>
      <Button type="button" variant={variant} className={buttonClass} disabled={entries.busy} title={FORMAT_HELP} aria-describedby={formatHelpId} onClick={() => inputRef.current?.click()}>
        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
        Add file
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ADD_DOCUMENT_ACCEPT}
        className="hidden"
        aria-label="Add file"
        aria-describedby={formatHelpId}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void entries.addFile(file);
          event.currentTarget.value = '';
        }}
      />
      <span id={formatHelpId} className="sr-only">{FORMAT_HELP}</span>
    </div>
  ) : null;
  const error = entries.error ? (
    <ErrorLine className={empty ? 'mt-3' : 'mt-2'} align={empty ? 'center' : 'start'}>{entries.error}</ErrorLine>
  ) : null;

  if (empty) {
    return (
      <div data-chat-artifacts-empty="" className="flex min-h-[14rem] shrink-0 flex-col items-center justify-center px-6 py-6 text-center">
        <FolderOpen aria-hidden="true" className="h-5 w-5 text-[color:var(--utility-muted-text)] opacity-70" strokeWidth={1.75} />
        <p className="m-0 mt-2.5 text-[13px] leading-5 text-[color:var(--utility-muted-text)]">{emptyLabel}</p>
        {actions}
        {error}
      </div>
    );
  }

  return (
    <div className="shrink-0 pb-3">
      {actions}
      {error}
    </div>
  );
}
