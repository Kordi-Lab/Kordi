import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { MessageBubbleShapeBackdrop, humanMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
import { cn } from '@/lib/utils';

type TranscriptMessageSurfaceProps = ComponentPropsWithoutRef<'div'> & {
  attachmentPreview: ReactNode;
  borderless: boolean;
  bubbleClassName: string;
  compact: boolean;
  detachedImageGroup: boolean;
  enter: boolean;
  side: 'own' | 'peer' | 'agent';
};

export function TranscriptMessageSurface({
  attachmentPreview,
  borderless,
  bubbleClassName,
  children,
  className,
  compact,
  detachedImageGroup,
  enter,
  side,
  ...props
}: TranscriptMessageSurfaceProps) {
  const backdrop = side === 'agent' ? null : <MessageBubbleShapeBackdrop side={side} />;
  const captionClassName = cn(
    'relative w-fit max-w-full shadow-sm',
    enter && 'app-message-bubble-enter',
    side === 'own'
      ? compact
        ? cn('app-message-bubble-contact-compact rounded-[8px] px-3 py-1.5', humanMessageBubbleShapeClass('own'))
        : cn('px-4 py-2.5', humanMessageBubbleShapeClass('own'))
      : side === 'peer'
        ? compact
          ? cn('app-message-bubble-contact-compact rounded-[8px] px-3 py-1.5', humanMessageBubbleShapeClass('peer'))
          : cn('px-4 py-2.5', humanMessageBubbleShapeClass('peer'))
        : 'rounded-[20px] px-3.5 py-2.5',
    bubbleClassName,
  );

  return (
    <div {...props} className={className}>
      {detachedImageGroup ? (
        <>
          {attachmentPreview}
          <div data-message-caption-bubble="true" className={captionClassName}>{backdrop}{children}</div>
        </>
      ) : <>{!borderless ? backdrop : null}{children}</>}
    </div>
  );
}
