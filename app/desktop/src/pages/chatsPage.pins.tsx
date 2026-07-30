import { Pin, X } from 'lucide-react';

import type { Message } from '@/kordi-app/types';

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
  message,
  onOpenMessage,
  onRequestUnpin,
}: {
  message: Message;
  onOpenMessage?: () => void;
  onRequestUnpin: () => void;
}) {
  const sender = pinnedMessageSenderLabel(message);
  const preview = pinnedMessagePreview(message);
  return (
    <div
      data-pinned-message-bar="true"
      className="app-pinned-message-bar shrink-0 border-b border-[color:var(--app-divider)] px-4 py-2"
      style={{
        background:
          'color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-text) 6%)',
      }}
    >
      <div className="flex min-h-9 items-center gap-2.5">
        <Pin
          className="h-3.5 w-3.5 shrink-0 text-[color:var(--utility-muted-text)]"
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={onOpenMessage}
          className="min-w-0 flex-1 text-left"
          aria-label="Open pinned message"
        >
          <div className="text-[12px] font-medium leading-4 text-[color:var(--utility-muted-text)]">
            pinged
          </div>
          <div className="truncate text-[13px] leading-4 text-[color:var(--app-text)]">
            {sender ? `${sender}: ${preview}` : preview}
          </div>
        </button>
        <button
          type="button"
          onClick={onRequestUnpin}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[color:var(--utility-muted-text)] transition hover:bg-[color:var(--app-hover-bg)] hover:text-[color:var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[color:var(--app-focus)]"
          aria-label="Unpin pinned message"
          title="Unpin pinned message"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
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
            className="app-transient-row rounded-[10px] px-3 py-1.5 transition"
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
