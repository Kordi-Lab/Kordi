import { useEffect, useId, useRef, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';

import { shouldDismissAttachmentImageLightboxForTarget } from './transcriptAttachmentLightboxHitTest';
import type { MessageAttachment } from '../types';

export function AttachmentImageLightbox({
  attachment,
  previewUrl,
  previewStatus = 'ready',
  onImageLoad,
  onImageError,
  onClose,
  onContextMenu,
  canGoPrevious = false,
  canGoNext = false,
  onPrevious,
  onNext,
  positionLabel,
  zoom = 1,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  attachment: MessageAttachment;
  previewUrl?: string | null;
  previewStatus?: 'loading' | 'ready' | 'unavailable';
  onImageLoad?: () => void;
  onImageError?: () => void;
  onClose: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  canGoPrevious?: boolean;
  canGoNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  positionLabel?: string;
  zoom?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
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
      className="app-attachment-image-lightbox fixed inset-0 flex items-center justify-center"
      role="dialog"
      aria-label={`Image preview: ${imageName}`}
      aria-describedby={instructionId}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (shouldDismissAttachmentImageLightboxForTarget(imageRef.current, event.target)) onClose();
      }}
    >
      <div
        data-tauri-drag-region
        data-attachment-image-lightbox-control="true"
        className="app-attachment-image-lightbox-titlebar"
        aria-hidden="true"
      />
      <span id={instructionId} className="sr-only">
        Image preview in a separate window. Press Escape to close. Use the left and right arrow keys to move between images.
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
      {previewUrl ? (
        <img
          ref={imageRef}
          src={previewUrl}
          alt={imageName}
          className="app-attachment-image-lightbox-image"
          data-attachment-image-zoom={zoom}
          style={{ transform: `scale(${zoom})` }}
          draggable={false}
          onLoad={onImageLoad}
          onError={onImageError}
          onContextMenu={onContextMenu}
        />
      ) : (
        <div className="app-attachment-image-lightbox-status" role="status" aria-live="polite">
          {previewStatus === 'unavailable' ? 'Image preview unavailable' : 'Opening image…'}
        </div>
      )}
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
      {positionLabel ? (
        <div
          data-attachment-image-lightbox-control="true"
          className="app-attachment-image-lightbox-position"
          aria-label={`Image ${positionLabel}`}
        >
          {positionLabel}
        </div>
      ) : null}
      {onZoomIn && onZoomOut && onZoomReset ? (
        <div
          data-attachment-image-lightbox-control="true"
          className="app-attachment-image-lightbox-zoom-controls"
          role="group"
          aria-label="Image zoom"
        >
          <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out (⌘−)">
            <Minus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="app-attachment-image-lightbox-zoom-value"
            onClick={onZoomReset}
            aria-label={`Reset zoom, currently ${Math.round(zoom * 100)}%`}
            title="Actual size (⌘0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in (⌘+)">
            <Plus aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
