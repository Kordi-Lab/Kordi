import { Check, CheckCheck, LoaderCircle, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { messageDeliveryVisual } from '@/features/chat/deliveryStatus';
import { cn } from '@/lib/utils';

import type { Message } from '../types';
import { TranscriptFileAttachmentUploadActions } from './transcriptFileAttachmentLink';

function MessageDeliveryClockGlyph({ className, active }: { className?: string; active: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={cn(className, active && 'app-message-delivery-clock-active')}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="app-message-delivery-clock-face" cx="8" cy="8" r="5.7" />
      <line className="app-message-delivery-clock-hour-hand" x1="8" y1="8" x2="8" y2="5.4" />
      <line className="app-message-delivery-clock-minute-hand" x1="8" y1="8" x2="8" y2="3.7" />
      <circle className="app-message-delivery-clock-pin" cx="8" cy="8" r="0.75" />
    </svg>
  );
}

function MessageDeliveryGlyph({ status }: { status?: string | null }) {
  const normalizedStatus = status?.trim().toLowerCase() || 'none';
  const visual = messageDeliveryVisual(status);
  const toneClass = visual?.tone === 'blue'
    ? 'text-sky-400'
    : visual?.tone === 'red'
      ? 'text-rose-600'
      : 'text-slate-400';
  const activeGlyph = visual?.glyph ?? 'none';
  const glyphClass = (glyph: NonNullable<ReturnType<typeof messageDeliveryVisual>>['glyph']) => cn(
    'absolute inset-0 h-3.5 w-3.5 transition-opacity duration-100',
    activeGlyph === glyph ? 'opacity-100' : 'opacity-0',
    toneClass,
  );

  return (
    <span
      className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      data-message-delivery-status={normalizedStatus}
      data-message-delivery-glyph={activeGlyph}
      aria-label={visual?.label}
      role={visual ? 'img' : undefined}
      aria-hidden={visual ? undefined : true}
    >
      <Check className={glyphClass('single-check')} aria-hidden="true" />
      <CheckCheck className={glyphClass('double-check')} aria-hidden="true" />
      <MessageDeliveryClockGlyph className={glyphClass('clock')} active={Boolean(visual?.glyph === 'clock' && visual.motion === 'pulse')} />
      <LoaderCircle className={cn(glyphClass('spinner'), activeGlyph === 'spinner' && 'animate-spin')} aria-hidden="true" />
      <span className={cn(glyphClass('exclamation'), 'inline-flex items-center justify-center text-[13px] font-semibold leading-none')} aria-hidden="true">
        !
      </span>
    </span>
  );
}

export function MessageDeliveryStatusSlot({ status }: { status?: string | null }) {
  return (
    <span
      className="inline-flex h-3.5 w-4 shrink-0 justify-center"
      data-message-delivery-status={status?.trim().toLowerCase() || 'none'}
      aria-live="off"
    >
      <MessageDeliveryGlyph status={status} />
    </span>
  );
}

export function TranscriptMessageTransferActions({
  message,
  showUploads,
  retryable,
  onRetryMessage,
}: {
  message: Message;
  showUploads: boolean;
  retryable: boolean;
  onRetryMessage?: (message: Message) => void;
}) {
  return (
    <>
      {showUploads ? <TranscriptFileAttachmentUploadActions attachments={message.attachments ?? []} /> : null}
      {retryable && onRetryMessage ? (
        <Button
          type="button"
          variant="quiet"
          size="icon"
          data-message-retry-button="true"
          data-message-transfer-action-side="opposite-avatar"
          className="app-message-transfer-action mb-0.5 h-7 w-7 shrink-0 self-end rounded-full p-0 text-rose-600"
          onClick={() => onRetryMessage(message)}
          aria-label="Retry sending message"
          title="Retry sending message"
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </Button>
      ) : null}
    </>
  );
}
