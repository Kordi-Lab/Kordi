import { useState } from 'react';
import { ChevronDown, Pin, X } from 'lucide-react';

import type { Message } from '@/kordi-app/types';
import type { PinnedMessageItem } from '@/pages/chatsPage.pinModel';

function pinnedMessagePreview(message: Message) {
  const text =
    message.turn?.assistantText?.trim()
    || message.text.trim()
    || message.detail?.trim();
  if (text) return text.replace(/\s+/g, ' ');
  const attachments = message.attachments ?? [];
  if (attachments.length === 1) {
    return attachments[0]?.kind === 'image'
      ? 'Photo'
      : attachments[0]?.name || 'Attachment';
  }
  if (attachments.length > 1) return `${attachments.length} attachments`;
  return 'Message';
}

function pinnedMessageSenderLabel(message: Message) {
  const sourceLabel = message.sourceSenderLabel?.trim();
  if (sourceLabel && sourceLabel.toLowerCase() !== 'me') return sourceLabel;
  const sender = message.sender?.trim();
  if (sender && sender.toLowerCase() !== 'me') return sender;
  return sourceLabel || sender || '';
}

export function PinnedMessageBar({
  items,
  onOpenMessage,
  onRequestUnpin,
}: {
  items: readonly PinnedMessageItem[];
  onOpenMessage: (message: Message) => void;
  onRequestUnpin: (item: PinnedMessageItem) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isCollapsible = items.length > 1;
  const showsItems = !isCollapsible || isExpanded;
  const heading = `${items.length} pinned ${items.length === 1 ? 'message' : 'messages'}`;
  const header = (
    <>
      <Pin className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="flex-1">{heading}</span>
      {isCollapsible ? (
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  return (
    <div
      data-pinned-message-bar="true"
      data-pinned-message-count={items.length}
      data-pinned-message-expanded={showsItems}
      className="app-pinned-message-bar shrink-0 border-b border-[color:var(--app-divider)]"
      style={{
        background:
          'color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-text) 6%)',
      }}
    >
      {items.length > 0 ? (
        <div className="px-3 py-1.5">
          {isCollapsible ? (
            <button
              type="button"
              onClick={() => setIsExpanded((current) => !current)}
              className="app-button-quiet flex h-8 w-full items-center gap-2 rounded-[8px] px-1 text-left text-[11px] font-semibold text-[color:var(--utility-muted-text)]"
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${heading}`}
            >
              {header}
            </button>
          ) : (
            <div className="flex h-6 items-center gap-2 px-1 text-[11px] font-semibold text-[color:var(--utility-muted-text)]">
              {header}
            </div>
          )}
          {showsItems ? <div className="divide-y divide-[color:var(--app-divider)]">
            {items.map((item) => {
              const sender = pinnedMessageSenderLabel(item.message);
              const preview = pinnedMessagePreview(item.message);
              const scopeDescription = item.scope === 'shared' ? 'for everyone' : 'only for you';
              return (
                <div
                  key={`${item.scope}:${item.message.id}`}
                  className="flex min-h-10 items-center gap-2"
                >
                  <button
                    type="button"
                    onClick={() => onOpenMessage(item.message)}
                    className="min-w-0 flex-1 rounded-[8px] px-1 py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                    aria-label={`Open message pinned ${scopeDescription}`}
                  >
                    <span className="block truncate text-[13px] leading-4 text-[color:var(--app-text)]">
                      {sender ? `${sender}: ${preview}` : preview}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRequestUnpin(item)}
                    className="app-button-quiet inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0"
                    aria-label={`Unpin message pinned ${scopeDescription}`}
                    title={`Unpin message pinned ${scopeDescription}`}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function PinActivityNotice({ label }: { label: string }) {
  return (
    <div className="flex justify-center px-2 py-2" data-pin-activity="true" role="status">
      <span className="app-system-notice-text max-w-[min(100%,34rem)] truncate px-2.5 py-0.5 text-center text-[11px] leading-5 text-[color:var(--utility-muted-text)]">
        {label}
      </span>
    </div>
  );
}

export function PinMessageDialog({
  mode,
  message: _message,
  pinForEveryone,
  onTogglePinForEveryone,
  onCancel,
  onConfirm,
}: {
  mode: 'pin' | 'unpin';
  message: Message;
  pinForEveryone: boolean;
  onTogglePinForEveryone: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isPin = mode === 'pin';
  return (
    <div
      className="app-transient-overlay fixed inset-0 z-[300] grid place-items-center px-4"
      data-pin-message-dialog={mode}
    >
      <div className="app-transient-surface w-full max-w-[28rem] rounded-[18px] border px-6 py-5">
        <div className="text-[15px] font-medium leading-6">
          {isPin ? 'Pin this message?' : 'Unpin this message?'}
        </div>
        {isPin ? (
          <label className="mt-5 flex items-center gap-3 text-[14px] font-medium leading-5">
            <input
              type="checkbox"
              checked={pinForEveryone}
              onChange={(event) =>
                onTogglePinForEveryone(event.currentTarget.checked)
              }
              className="h-5.5 w-5.5 rounded border-2 border-[color:var(--app-transient-border)]"
            />
            <span>Pin for everyone</span>
          </label>
        ) : null}
        <div className="mt-6 flex justify-end gap-2 text-[14px] font-semibold">
          <button
            type="button"
            onClick={onCancel}
            className="app-button-quiet app-transient-flat-action rounded-[10px] px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="app-transient-row app-transient-row-selected rounded-[10px] px-3 py-1.5 transition"
          >
            {isPin ? 'Pin' : 'Unpin'}
          </button>
        </div>
      </div>
    </div>
  );
}
