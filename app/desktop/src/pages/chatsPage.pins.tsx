import type { PinActivity } from '@/pages/chatsPage.pinActivity';
import { useLayoutEffect, useRef, useState } from 'react';
import { formatDesktopTranscriptTimeLabel } from '@/lib/time';
import { revealPinActivity } from '@/pages/pinActivityMotion';
import { List, Pin, X } from 'lucide-react';

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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDialogElement>(null);
  const itemKey = (item: PinnedMessageItem) => `${item.scope}:${item.message.id}`;
  const selectedIndex = Math.max(0, items.findIndex((item) => itemKey(item) === selectedKey));
  const activeItem = items[selectedIndex];
  if (!activeItem) return null;
  const cycle = () => {
    const next = items[(selectedIndex + 1) % items.length];
    setSelectedKey(itemKey(next));
    onOpenMessage(next.message);
  };
  return (
    <div
      data-pinned-message-bar="true"
      data-pinned-message-count={items.length}
      data-pinned-message-index={selectedIndex}
      className="app-pinned-message-bar app-pin-stack"
    >
      <button type="button" className="app-pin-stack-cycle" onClick={cycle}
        aria-label={items.length > 1 ? `Next pinned message, ${selectedIndex + 1} of ${items.length}` : 'Open pinned message'}>
        <span className="app-pin-stack-markers" aria-hidden="true">
          {items.map((item, index) => <span key={itemKey(item)} data-active={index === selectedIndex} />)}
        </span>
        <span className="app-pin-stack-copy" aria-live="polite" aria-atomic="true">
          <span className="app-pin-stack-heading">Pinned message
            {items.length > 1 ? <span className="app-pin-stack-position">{selectedIndex + 1} / {items.length}</span> : null}
          </span>
          <span className="app-pin-stack-preview" key={itemKey(activeItem)}>{pinnedMessagePreview(activeItem.message)}</span>
        </span>
      </button>
      <button type="button" className="app-pin-stack-list-button" onClick={() => listRef.current?.showModal()}
        aria-label={`View all ${items.length} pinned messages`} title="View pinned messages">
        <Pin size={21} aria-hidden="true" /><List size={18} aria-hidden="true" />
      </button>
      <dialog ref={listRef} aria-label="Pinned messages" className="app-pin-list-dialog" onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) listRef.current?.close();
      }}>
        <header className="app-pin-list-header">
          <h2>Pinned messages</h2>
          <button type="button" onClick={() => listRef.current?.close()} aria-label="Close pinned messages"><X size={20} /></button>
        </header>
        <div className="app-pin-list-items">
          {items.map((item) => <div className="app-pin-list-row" key={itemKey(item)}>
            <button type="button" className="app-pin-list-open" onClick={() => {
              setSelectedKey(itemKey(item));
              listRef.current?.close();
              onOpenMessage(item.message);
            }}>
              <span className="app-pin-list-sender">{pinnedMessageSenderLabel(item.message) || 'Message'}<span>{item.scope === 'shared' ? 'Everyone' : 'Only you'}</span></span>
              <span>{pinnedMessagePreview(item.message)}</span>
            </button>
            <button type="button" className="app-pin-list-unpin" aria-label={`Unpin ${pinnedMessagePreview(item.message)}`} onClick={() => {
              listRef.current?.close();
              onRequestUnpin(item);
            }}><X size={16} aria-hidden="true" /></button>
          </div>)}
        </div>
      </dialog>
    </div>
  );
}

export function PinActivityNotice({ activity }: { activity: PinActivity }) {
  const date = new Date(activity.timestampMs);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!activity.animate || !noticeRef.current) return;
    const animation = revealPinActivity(noticeRef.current, activity.id);
    return () => animation?.cancel();
  }, [activity.animate, activity.id]);
  return (
    <div ref={noticeRef} className="flex min-h-[60px] flex-col items-center gap-1 px-2 py-2 text-center" data-pin-activity="true" role="status">
      <time
        dateTime={date.toISOString()}
        className="text-[11px] leading-4 tabular-nums text-[color:var(--utility-muted-text)]"
      >
        {formatDesktopTranscriptTimeLabel(activity.timestampMs)}
      </time>
      <span className="app-system-notice-text max-w-[min(100%,34rem)] truncate px-2.5 py-0.5 text-center text-[11px] leading-5 text-[color:var(--utility-muted-text)]">
        {activity.label}
      </span>
    </div>
  );
}

export function PinMessageDialog({
  mode,
  message: _message,
  pinForEveryone,
  error,
  onTogglePinForEveryone,
  onCancel,
  onConfirm,
}: {
  mode: 'pin' | 'unpin';
  message: Message;
  pinForEveryone: boolean;
  error?: string | null;
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
        {error ? <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
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
