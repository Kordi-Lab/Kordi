import type {Message} from '@/kordi-app/types';
import {humanMessageBubbleShapeClass,MessageBubbleShapeBackdrop} from '@/features/chat/messageBubbleShape';

type TranscriptLoadingPlaceholder = NonNullable<
  Message['loadingPlaceholders']
>[number];

function TranscriptSkeletonHumanRow({
  placeholder,
  compact,
}: {
  placeholder: TranscriptLoadingPlaceholder;
  compact: boolean;
}) {
  const { side, kind, lines, width } = placeholder;
  const own = side === 'own';
  return (
    <div
      className={`flex w-full flex-col gap-1 ${compact ? 'pb-0.5 pt-0.5' : 'pb-1 pt-1'} ${own ? 'items-end' : 'items-start'}`}
      data-transcript-skeleton-kind={kind}
      data-transcript-skeleton-source="cached"
    >
      <div
        className={`flex w-full max-w-full items-end ${compact ? 'gap-1.5' : 'gap-2'} ${own ? 'flex-row-reverse' : 'flex-row'}`}
      >
        <div
          className={`app-transcript-skeleton-surface app-transcript-skeleton-avatar mb-0.5 shrink-0 rounded-full ${compact ? 'h-7 w-7' : 'h-8 w-8'}`}
        />
        <div
          className={`app-message-hover-time-trigger app-transcript-skeleton-bubble min-w-0 max-w-[52rem] text-[14px] shadow-sm ${
            compact
              ? 'app-message-bubble-contact-compact rounded-[8px] px-3 py-1.5'
              : 'px-4 py-2.5'
          } ${
            own
              ? 'app-chat-bubble-user app-transcript-skeleton-bubble-own'
              : 'app-chat-bubble-peer app-transcript-skeleton-bubble-peer'
          } ${humanMessageBubbleShapeClass(side)}`}
          data-transcript-skeleton-width={width}
        >
          <MessageBubbleShapeBackdrop side={side} />
          {kind === 'link' ? (
            <div className="flex items-center gap-2">
              <div className="app-transcript-skeleton-surface app-transcript-skeleton-link-icon shrink-0 rounded-[3px]" />
              <div className="min-w-0 flex-1">
                {Array.from({ length: lines }, (_, index) => (
                  <div
                    key={index}
                    className={`app-transcript-skeleton-surface app-transcript-skeleton-line ${index === lines - 1 && lines > 1 ? 'app-transcript-skeleton-line-short' : 'app-transcript-skeleton-line-long'}`}
                  />
                ))}
              </div>
            </div>
          ) : (
            Array.from({ length: lines }, (_, index) => (
              <div
                key={index}
                className={`app-transcript-skeleton-surface app-transcript-skeleton-line ${index === lines - 1 && lines > 1 ? 'app-transcript-skeleton-line-short' : 'app-transcript-skeleton-line-long'}`}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptSkeletonImageRow({
  side,
  compact,
}: {
  side: TranscriptLoadingPlaceholder['side'];
  compact: boolean;
}) {
  const own = side === 'own';
  return (
    <div
      className={`flex w-full flex-col gap-1 ${compact ? 'pb-0.5 pt-0.5' : 'pb-1 pt-1'} ${own ? 'items-end' : 'items-start'}`}
      data-transcript-skeleton-kind="image"
      data-transcript-skeleton-source="cached"
    >
      <div
        className={`flex w-full max-w-full items-start ${compact ? 'gap-1.5' : 'gap-2'} ${own ? 'flex-row-reverse' : 'flex-row'}`}
      >
        <div
          className={`app-transcript-skeleton-surface app-transcript-skeleton-avatar mb-0.5 shrink-0 rounded-full ${compact ? 'h-7 w-7' : 'h-8 w-8'}`}
        />
        <div
          className="min-w-0 w-fit max-w-[31rem] bg-transparent p-0 text-[14px] shadow-none"
          data-message-media-side={side}
        >
          <div className="app-attachment-image-collage relative grid w-[min(100%,20rem)] max-w-[min(100%,29rem)] grid-cols-6 auto-rows-[4rem] gap-0.5 overflow-hidden rounded-[16px] p-0">
            <div className="app-attachment-image-card app-attachment-image-tile app-transcript-skeleton-surface relative col-span-6 row-span-3 overflow-hidden rounded-[16px] bg-black/[0.035]">
              <div className="relative flex h-full min-h-28 aspect-[4/3]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TranscriptSkeletonAgentRow({
  placeholder,
}: {
  placeholder: TranscriptLoadingPlaceholder;
}) {
  return (
    <div
      className="flex w-full max-w-[min(100%,61rem)] flex-col items-start py-0.5"
      data-transcript-skeleton-kind="agent"
      data-transcript-skeleton-source="cached"
    >
      <div
        className="app-chat-bubble-agent app-transcript-skeleton-agent max-w-[58rem] rounded-[20px] px-3.5 py-2.5"
        data-transcript-skeleton-width={placeholder.width}
      >
        {Array.from({ length: placeholder.lines }, (_, index) => (
          <div
            key={index}
            className={`app-transcript-skeleton-surface app-transcript-skeleton-line ${index === placeholder.lines - 1 && placeholder.lines > 1 ? 'app-transcript-skeleton-line-short' : 'app-transcript-skeleton-line-long'}`}
          />
        ))}
      </div>
    </div>
  );
}

export function TranscriptLoadingSkeleton({
  compact,
  placeholders,
}: {
  compact: boolean;
  placeholders: readonly TranscriptLoadingPlaceholder[];
}) {
  return (
    <div
      className="app-chat-pane-transcript-scroll app-transcript-loading-skeleton flex min-h-0 flex-1 flex-col overflow-hidden"
      data-transcript-loading-skeleton="true"
      aria-hidden="true"
    >
      <div className="flex w-full flex-col gap-1" aria-hidden="true">
        {placeholders.map((placeholder, index) => (
          placeholder.kind === 'image' ? (
            <TranscriptSkeletonImageRow
              key={`${placeholder.kind}:${placeholder.side}:${index}`}
              side={placeholder.side}
              compact={compact}
            />
          ) : placeholder.kind === 'agent' ? (
            <TranscriptSkeletonAgentRow
              key={`${placeholder.kind}:${placeholder.side}:${index}`}
              placeholder={placeholder}
            />
          ) : (
            <TranscriptSkeletonHumanRow
              key={`${placeholder.kind}:${placeholder.side}:${index}`}
              placeholder={placeholder}
              compact={compact}
            />
          )
        ))}
      </div>
    </div>
  );
}
