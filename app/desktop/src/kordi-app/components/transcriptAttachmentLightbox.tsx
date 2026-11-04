import { LivePhotoPlayback } from './livePhotoPlayback';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { nextAttachmentMediaZoom } from '@/features/chat/attachmentMediaZoom';

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
  onZoomChange,
  onActualSizeZoomChange,
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
  onZoomChange?: (zoom: number) => void;
  onActualSizeZoomChange?: (zoom: number) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [liveControls, setLiveControls] = useState<HTMLDivElement | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean; panX: number; panY: number } | null>(null);
  const suppressClick = useRef(false);
  const actualSizeZoom = useCallback(() => {
    const image = imageRef.current;
    return image?.clientWidth && image.naturalWidth ? image.naturalWidth / image.clientWidth : 1;
  }, []);
  const reportActualSize = useCallback(() => {
    const image = imageRef.current;
    if (image) setImageSize((current) => current.width === image.clientWidth && current.height === image.clientHeight
      ? current : { width: image.clientWidth, height: image.clientHeight });
    onActualSizeZoomChange?.(actualSizeZoom());
  }, [actualSizeZoom, onActualSizeZoomChange]);
  const panLimitX = imageSize.width * Math.max(0, zoom - 1) / 2;
  const panLimitY = imageSize.height * Math.max(0, zoom - 1) / 2;
  const offset = { x: Math.max(-panLimitX, Math.min(panLimitX, pan.x)), y: Math.max(-panLimitY, Math.min(panLimitY, pan.y)) };
  const imageTransform = offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` : `scale(${zoom})`;
  const instructionId = useId();
  const imageName = attachment.name?.trim() || 'Attached image';
  const presentedSource = useRef<string | null>(null);
  const presentDecodedImage = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    const source = image.currentSrc || image.src;
    const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
    void decoded.then(() => {
      if (imageRef.current !== image || (image.currentSrc || image.src) !== source
        || !image.naturalWidth || presentedSource.current === source) return;
      image.getBoundingClientRect();
      reportActualSize();
      presentedSource.current = source;
      onImageLoad?.();
    }).catch(() => undefined);
  }, [onImageLoad, reportActualSize]);
  useEffect(() => {
    if (imageRef.current?.complete && imageRef.current.naturalWidth) presentDecodedImage();
  }, [presentDecodedImage, previewUrl]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportActualSize);
    observer.observe(image);
    return () => observer.disconnect();
  }, [previewUrl, reportActualSize]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || !onZoomChange) return;
    function handleWheel(event: WheelEvent) {
      if (!event.deltaY) return;
      event.preventDefault();
      onZoomChange?.(nextAttachmentMediaZoom(zoom, event.deltaY < 0 ? 'in' : 'out', actualSizeZoom()));
    }
    image.addEventListener('wheel', handleWheel, { passive: false });
    return () => image.removeEventListener('wheel', handleWheel);
  }, [actualSizeZoom, onZoomChange, previewUrl, zoom]);

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
        Image preview in a separate window. Press Escape to close. Use the left and right arrow keys to move between images. Click the image to toggle actual size, scroll to zoom, and drag to pan. Press Command or Control plus zero to fit the image.
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
          style={{ transform: imageTransform, cursor: zoom > 1 ? 'grab' : 'zoom-in', touchAction: 'none' }}
          draggable={false}
          onLoad={presentDecodedImage}
          onError={onImageError}
          onContextMenu={onContextMenu}
          onClick={() => {
            if (suppressClick.current) { suppressClick.current = false; return; }
            setPan({ x: 0, y: 0 });
            reportActualSize();
            onZoomChange?.(zoom === 1 ? actualSizeZoom() : 1);
          }}
          onPointerDown={(event) => {
            suppressClick.current = false;
            if (event.button !== 0 || zoom <= 1) return;
            drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, panX: offset.x, panY: offset.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.pointerId !== event.pointerId) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.hypot(dx, dy) > 3) start.moved = true;
            if (start.moved) setPan({ x: start.panX + dx, y: start.panY + dy });
          }}
          onPointerUp={() => {
            suppressClick.current = drag.current?.moved ?? false;
            drag.current = null;
          }}
          onPointerCancel={() => { drag.current = null; }}
          onLostPointerCapture={() => { drag.current = null; }}
        />
      ) : (
        <div className="app-attachment-image-lightbox-status" role="status" aria-live="polite">
          {previewStatus === 'unavailable' ? 'Image preview unavailable' : 'Opening image…'}
        </div>
      )}
      {attachment.livePhoto || attachment.livePhotoFiles ? <LivePhotoPlayback key={attachment.attachmentId ?? attachment.localPath ?? attachment.name} livePhoto={attachment.livePhoto} localVideoPath={attachment.livePhotoFiles?.playbackPath} zoom={zoom} imageTransform={imageTransform} controlsTarget={liveControls} imageRef={imageRef} imageUrl={previewUrl} /> : null}
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
          ref={setLiveControls}
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
            onClick={() => { setPan({ x: 0, y: 0 }); onZoomReset(); }}
            aria-label={`Reset zoom, currently ${Math.round(zoom * 100)}%`}
            title="Fit to window (⌘0)"
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

export function AttachmentVideoLightbox({
  attachment,
  videoUrl,
  posterUrl,
  initialTime = 0,
  onVideoLoad,
  onVideoError,
  onClose,
  onContextMenu,
}: {
  attachment: MessageAttachment;
  videoUrl?: string | null;
  posterUrl?: string | null;
  initialTime?: number;
  onVideoLoad?: () => void;
  onVideoError?: () => void;
  onClose: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const instructionId = useId();
  const videoName = attachment.name?.trim() || 'Attached video';

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={dialogRef}
      data-attachment-video-lightbox="true"
      className="app-attachment-video-lightbox fixed inset-0 flex items-center justify-center"
      role="dialog"
      aria-label={`Video preview: ${videoName}`}
      aria-describedby={instructionId}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (shouldDismissAttachmentImageLightboxForTarget(videoRef.current, event.target)) onClose();
      }}
    >
      <div
        data-tauri-drag-region
        data-attachment-image-lightbox-control="true"
        className="app-attachment-image-lightbox-titlebar"
        aria-hidden="true"
      />
      <span id={instructionId} className="sr-only">
        Video preview in a separate window. Press Escape to close.
      </span>
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          poster={posterUrl ?? undefined}
          controls
          controlsList="nofullscreen"
          autoPlay
          playsInline
          preload="auto"
          className="app-attachment-video-lightbox-video"
          aria-label={`Play ${videoName}`}
          onLoadedMetadata={(event) => {
            if (Number.isFinite(initialTime) && initialTime > 0) {
              event.currentTarget.currentTime = initialTime;
            }
            onVideoLoad?.();
          }}
          onError={onVideoError}
          onContextMenu={onContextMenu}
        />
      ) : (
        <div className="app-attachment-image-lightbox-status" role="status" aria-live="polite">
          Video preview unavailable
        </div>
      )}
    </div>
  );
}
