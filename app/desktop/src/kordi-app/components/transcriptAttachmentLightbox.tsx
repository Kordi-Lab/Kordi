import { useEffect, useId, useRef, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { shouldDismissAttachmentImageLightboxForTarget } from './transcriptAttachmentLightboxHitTest';
import type { MessageAttachment } from '../types';

export function AttachmentImageLightbox({
  attachment,
  previewUrl,
  onClose,
  onContextMenu,
  canGoPrevious = false,
  canGoNext = false,
  onPrevious,
  onNext,
}: {
  attachment: MessageAttachment;
  previewUrl: string;
  onClose: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  canGoPrevious?: boolean;
  canGoNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const instructionId = useId();
  const imageName = attachment.name?.trim() || 'Attached image';

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={dialogRef}
      data-attachment-image-lightbox="true"
      className="app-attachment-image-lightbox fixed inset-0 z-[220] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${imageName}`}
      aria-describedby={instructionId}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (shouldDismissAttachmentImageLightboxForTarget(imageRef.current, event.target)) onClose();
      }}
    >
      <span id={instructionId} className="sr-only">
        Image preview. Press Escape to close. Use the left and right arrow keys to move between images.
      </span>
      {canGoPrevious && onPrevious ? (
        <button
          type="button"
          data-attachment-image-lightbox-control="true"
          className="app-attachment-image-lightbox-nav app-attachment-image-lightbox-nav-previous"
          onClick={onPrevious}
          aria-label="Previous image"
          title="Previous image"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      ) : null}
      <img
        ref={imageRef}
        src={previewUrl}
        alt={imageName}
        className="app-attachment-image-lightbox-image"
        draggable={false}
        title="Right-click for image actions"
        onContextMenu={onContextMenu}
      />
      {canGoNext && onNext ? (
        <button
          type="button"
          data-attachment-image-lightbox-control="true"
          className="app-attachment-image-lightbox-nav app-attachment-image-lightbox-nav-next"
          onClick={onNext}
          aria-label="Next image"
          title="Next image"
        >
          <ChevronRight aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
