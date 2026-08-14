import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type TranscriptImageGroupProps = {
  groupId: string;
  imageCount: number;
  isExpanded: boolean;
  isOwnMessage: boolean;
  loadingOnly: boolean;
  children: ReactNode;
  deliveryOverlay: ReactNode;
  onToggle: () => void;
};

function ImageGroupDisclosure({
  groupId,
  imageCount,
  isExpanded,
  onToggle,
}: Pick<TranscriptImageGroupProps, 'groupId' | 'imageCount' | 'isExpanded' | 'onToggle'>) {
  return (
    <button
      type="button"
      className="app-attachment-image-group-disclosure"
      data-attachment-image-group-disclosure="true"
      aria-expanded={isExpanded}
      aria-controls={groupId}
      onClick={onToggle}
    >
      {isExpanded ? 'Collapse' : `Expand ${imageCount}`}
    </button>
  );
}

export function TranscriptImageGroup({
  groupId,
  imageCount,
  isExpanded,
  isOwnMessage,
  loadingOnly,
  children,
  deliveryOverlay,
  onToggle,
}: TranscriptImageGroupProps) {
  const isGroup = imageCount > 1;
  const collage = (
    <div
      id={groupId}
      data-attachment-image-collage="true"
      data-attachment-image-count={imageCount}
      data-attachment-image-group-expanded={isGroup ? String(isExpanded) : undefined}
      className={cn(
        'app-attachment-image-collage relative rounded-[16px] p-0',
        isGroup
          ? cn(
            'app-attachment-image-group-media flex w-[11.25rem] flex-col gap-1.5 overflow-visible',
            !isExpanded && 'app-attachment-image-group-collapsed h-[11.25rem]',
          )
          : cn(
            'grid max-w-[min(100%,29rem)] grid-cols-6 gap-0.5 overflow-hidden',
            loadingOnly
              ? 'w-[min(100%,20rem)] auto-rows-[4rem]'
              : 'w-fit auto-rows-auto',
          ),
      )}
    >
      {children}
      {deliveryOverlay}
    </div>
  );

  if (!isGroup) return collage;

  const disclosure = (
    <ImageGroupDisclosure
      groupId={groupId}
      imageCount={imageCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );

  return (
    <div
      className="app-attachment-image-group-shell"
      data-attachment-image-group-side={isOwnMessage ? 'own' : 'peer'}
    >
      {isOwnMessage ? disclosure : null}
      {collage}
      {!isOwnMessage ? disclosure : null}
    </div>
  );
}
