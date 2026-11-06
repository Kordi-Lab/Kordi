import { humanMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
import { cn } from '@/lib/utils';

/** Classes for a transcript message surface: human bubbles, agent cards, and bare media. */
export function transcriptMessageSurfaceClassName({
  side, plain, detachedImageGroup, groupedImages, compact, supportTyping, voicePadding, animateEntry, bubble,
}: {
  side: 'own' | 'peer' | 'agent';
  /** Bare media, a detached image group, or a standalone emoji: no bubble chrome. */
  plain: boolean;
  detachedImageGroup: boolean;
  groupedImages: boolean;
  compact: boolean;
  supportTyping: boolean;
  voicePadding: boolean;
  animateEntry: boolean;
  bubble: string;
}) {
  const own = side === 'own';
  const peer = side === 'peer';
  return cn(
    'app-message-hover-time-trigger min-w-0',
    detachedImageGroup ? cn('flex flex-col gap-2', own ? 'items-end' : 'items-start') : '',
    groupedImages ? (own ? 'mr-4' : peer ? 'ml-4' : '') : '',
    plain ? 'bg-transparent shadow-none' : cn('shadow-sm', animateEntry && 'app-message-bubble-enter'),
    own || peer ? 'text-[14px]' : 'text-[13px]',
    own
      ? plain
        ? 'w-fit max-w-[31rem] p-0'
        : compact
          ? cn('app-message-bubble-contact-compact w-fit rounded-[8px] px-3 py-1.5', 'max-w-[52rem]', humanMessageBubbleShapeClass('own'))
          : cn('w-fit px-4 py-2.5', 'max-w-[52rem]', humanMessageBubbleShapeClass('own'))
      : peer
        ? plain
          ? 'w-fit max-w-[31rem] p-0'
          : compact
            ? cn(
              'app-message-bubble-contact-compact w-fit rounded-[8px] px-3 py-1.5', 'max-w-[52rem]',
              supportTyping ? 'min-w-[3.25rem]' : undefined,
              humanMessageBubbleShapeClass('peer'),
            )
            : cn(
              'w-fit px-4 py-2.5', 'max-w-[52rem]',
              supportTyping ? 'min-w-[4rem]' : undefined,
              humanMessageBubbleShapeClass('peer'),
            )
        : detachedImageGroup ? 'w-fit max-w-[31rem] p-0' : 'w-fit max-w-[58rem] rounded-[20px] px-3.5 py-2.5', voicePadding ? 'pl-2.5 py-1.5' : '',
    !plain && bubble,
  );
}
