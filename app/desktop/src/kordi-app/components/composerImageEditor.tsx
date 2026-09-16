import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Check, Crop, Paintbrush, RotateCw, X } from 'lucide-react';

import {
  COMPOSER_IMAGE_FULL_CROP,
  composerImageCropPixels,
  composerAttachmentItemFromFile,
  composerEditedImageOutput,
  movedComposerImageCrop,
  resizedComposerImageCrop,
  type ComposerImageCropHandle,
  type ComposerImageCropRect,
} from '@/features/chat/composerAttachments';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { readDesktopChatAttachment } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import {
  canvasBlob,
  copyCanvas,
  cropCanvas,
  renderCropPreview,
  restoreCanvas,
  rotateCanvasClockwise,
} from './composerImageCanvas';

const MAX_EDITABLE_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_EDITABLE_IMAGE_PIXELS = 40_000_000;
const INITIAL_CROP: ComposerImageCropRect = { x: 0.06, y: 0.06, width: 0.88, height: 0.88 };

function canvasPoint(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLCanvasElement>) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
    y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
  };
}

export function ComposerImageEditor({
  attachment,
  onClose,
  onSave,
}: {
  attachment: AttachmentItem;
  onClose: () => void;
  onSave: (attachment: AttachmentItem) => Promise<void> | void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropSourceRef = useRef<HTMLCanvasElement | null>(null);
  const cropRectRef = useRef<ComposerImageCropRect>({ ...COMPOSER_IMAGE_FULL_CROP });
  const cropGestureRef = useRef<{
    action: 'move' | ComposerImageCropHandle;
    point: { x: number; y: number };
    crop: ComposerImageCropRect;
  } | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isCropping, setIsCropping] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function loadImage() {
      try {
        if ((attachment.sizeBytes ?? 0) > MAX_EDITABLE_IMAGE_BYTES) {
          throw new Error('This image is too large to edit in Kordi.');
        }
        const bytes = await readDesktopChatAttachment(attachment.path);
        if (cancelled) return;
        if (bytes.length > MAX_EDITABLE_IMAGE_BYTES) {
          throw new Error('This image is too large to edit in Kordi.');
        }
        const blob = new Blob([new Uint8Array(bytes)], {
          type: attachment.mimeType?.trim() || 'application/octet-stream',
        });
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
          if (cancelled) return;
          if ((image.naturalWidth * image.naturalHeight) > MAX_EDITABLE_IMAGE_PIXELS) {
            setError('This image has too many pixels to edit safely in Kordi.');
            return;
          }
          const canvas = canvasRef.current;
          const context = canvas?.getContext('2d');
          if (!canvas || !context) {
            setError('Kordi could not open the image editor.');
            return;
          }
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          context.drawImage(image, 0, 0);
          setIsReady(true);
        };
        image.onerror = () => {
          if (!cancelled) setError('Kordi could not read this image.');
        };
        image.src = objectUrl;
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Kordi could not open this image.');
        }
      }
    }

    void loadImage();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.mimeType, attachment.path, attachment.sizeBytes]);

  function beginStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (isCropping && isReady) {
      const canvas = event.currentTarget;
      const point = canvasPoint(canvas, event);
      const pixels = composerImageCropPixels(cropRectRef.current, canvas.width, canvas.height);
      const bounds = canvas.getBoundingClientRect();
      const threshold = 18 * (canvas.width / Math.max(1, bounds.width));
      const handles: Array<[ComposerImageCropHandle, number, number]> = [
        ['top-left', pixels.x, pixels.y],
        ['top', pixels.x + pixels.width / 2, pixels.y],
        ['top-right', pixels.x + pixels.width, pixels.y],
        ['right', pixels.x + pixels.width, pixels.y + pixels.height / 2],
        ['bottom-right', pixels.x + pixels.width, pixels.y + pixels.height],
        ['bottom', pixels.x + pixels.width / 2, pixels.y + pixels.height],
        ['bottom-left', pixels.x, pixels.y + pixels.height],
        ['left', pixels.x, pixels.y + pixels.height / 2],
      ];
      const handle = handles.find(([, x, y]) => Math.hypot(point.x - x, point.y - y) <= threshold)?.[0];
      const inside = point.x >= pixels.x && point.x <= pixels.x + pixels.width
        && point.y >= pixels.y && point.y <= pixels.y + pixels.height;
      if (!handle && !inside) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      cropGestureRef.current = {
        action: handle ?? 'move',
        point,
        crop: cropRectRef.current,
      };
      return;
    }
    if (!isDrawing || !isReady) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    lastPointRef.current = canvasPoint(event.currentTarget, event);
  }

  function continueStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (isCropping && cropGestureRef.current) {
      event.preventDefault();
      const canvas = event.currentTarget;
      const gesture = cropGestureRef.current;
      const point = canvasPoint(canvas, event);
      const dx = (point.x - gesture.point.x) / canvas.width;
      const dy = (point.y - gesture.point.y) / canvas.height;
      cropRectRef.current = gesture.action === 'move'
        ? movedComposerImageCrop(gesture.crop, dx, dy)
        : resizedComposerImageCrop(gesture.crop, gesture.action, dx, dy);
      if (cropSourceRef.current) {
        renderCropPreview(canvas, cropSourceRef.current, cropRectRef.current);
      }
      return;
    }
    if (!drawingRef.current || !lastPointRef.current) return;
    event.preventDefault();
    const canvas = event.currentTarget;
    const context = canvas.getContext('2d');
    if (!context) return;
    const nextPoint = canvasPoint(canvas, event);
    context.beginPath();
    context.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    context.lineTo(nextPoint.x, nextPoint.y);
    context.strokeStyle = '#ff3b30';
    context.lineWidth = Math.max(3, Math.min(canvas.width, canvas.height) * 0.006);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.stroke();
    lastPointRef.current = nextPoint;
  }

  function endStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    cropGestureRef.current = null;
    drawingRef.current = false;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function stopCropPreview() {
    const canvas = canvasRef.current;
    if (canvas && cropSourceRef.current) restoreCanvas(canvas, cropSourceRef.current);
    cropSourceRef.current = null;
    cropGestureRef.current = null;
  }

  function startCropping() {
    const canvas = canvasRef.current;
    if (!canvas || !isReady || isCropping) return;
    setIsDrawing(false);
    setIsCropping(true);
    if (cropRectRef.current.width >= 0.999 && cropRectRef.current.height >= 0.999) {
      cropRectRef.current = { ...INITIAL_CROP };
    }
    cropSourceRef.current = copyCanvas(canvas);
    renderCropPreview(canvas, cropSourceRef.current, cropRectRef.current);
  }

  function toggleDrawing() {
    if (isCropping) stopCropPreview();
    setIsCropping(false);
    setIsDrawing((current) => !current);
  }

  function rotateImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (isCropping) stopCropPreview();
    try {
      rotateCanvasClockwise(canvas);
      cropRectRef.current = { ...COMPOSER_IMAGE_FULL_CROP };
      setIsCropping(false);
    } catch (rotateError) {
      setError(rotateError instanceof Error ? rotateError.message : 'Kordi could not rotate this image.');
    }
  }

  function handleCropKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    if (!isCropping || !cropSourceRef.current) return;
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key] as [number, number] | undefined;
    if (!direction) return;
    event.preventDefault();
    const step = event.altKey ? 0.05 : 0.01;
    cropRectRef.current = event.shiftKey
      ? resizedComposerImageCrop(
          cropRectRef.current,
          'bottom-right',
          direction[0] * step,
          direction[1] * step,
        )
      : movedComposerImageCrop(
          cropRectRef.current,
          direction[0] * step,
          direction[1] * step,
        );
    if (canvasRef.current) {
      renderCropPreview(canvasRef.current, cropSourceRef.current, cropRectRef.current);
    }
  }

  async function finishEditing() {
    const canvas = canvasRef.current;
    if (!canvas || !isReady || isFinishing) return;
    setIsFinishing(true);
    setError(null);
    try {
      if (isCropping) stopCropPreview();
      const crop = cropRectRef.current;
      if (crop.width < 0.999 || crop.height < 0.999) cropCanvas(canvas, crop);
      cropRectRef.current = { ...COMPOSER_IMAGE_FULL_CROP };
      setIsCropping(false);
      const requestedOutput = composerEditedImageOutput(attachment);
      const blob = await canvasBlob(canvas, requestedOutput.mimeType);
      const output = composerEditedImageOutput({
        mimeType: blob.type || requestedOutput.mimeType,
        name: requestedOutput.name,
      });
      const file = new File([blob], output.name, { type: output.mimeType });
      const replacement = await composerAttachmentItemFromFile(
        file,
        attachment.subtype === 'meme' ? { subtype: 'meme' } : {},
      );
      replacement.id = attachment.id;
      if (attachment.subtype === 'meme') {
        replacement.altText = attachment.altText ?? '';
        replacement.memeRightsConfirmed = attachment.memeRightsConfirmed === true;
      }
      await onSave(replacement);
      onClose();
    } catch (finishError) {
      setError(finishError instanceof Error ? finishError.message : 'Kordi could not finish editing this image. Try again.');
      setIsFinishing(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="app-composer-image-editor m-auto h-[min(760px,calc(100vh-32px))] w-[min(960px,calc(100vw-32px))] max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] overflow-hidden rounded-[16px] border border-[color:var(--app-divider)] bg-[color:var(--app-main-bg)] p-0 text-[color:var(--utility-foreground)] shadow-2xl"
      aria-labelledby="composer-image-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--app-divider)] px-4">
          <div className="min-w-0">
            <h2 id="composer-image-editor-title" className="truncate text-sm font-semibold">
              Edit image
            </h2>
            <p className="truncate text-[11px] text-[color:var(--utility-muted-text)]">
              {attachment.name}
            </p>
          </div>
          <button
            type="button"
            className="app-button-quiet app-icon-button grid h-10 w-10 shrink-0 place-items-center rounded-full p-0"
            onClick={onClose}
            aria-label="Close image editor"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/25 p-4">
          {error && !isReady ? (
            <p className="max-w-sm text-center text-sm leading-6 text-rose-400" role="alert">{error}</p>
          ) : null}
          {!error && !isReady ? (
            <p className="text-sm text-[color:var(--utility-muted-text)]" role="status">Opening image…</p>
          ) : null}
          <canvas
            ref={canvasRef}
            data-composer-image-editor-canvas="true"
            data-drawing={isDrawing ? 'true' : 'false'}
            data-cropping={isCropping ? 'true' : 'false'}
            className={cn(
              'max-h-full max-w-full object-contain shadow-[0_16px_42px_rgba(0,0,0,0.32)]',
              !isReady && 'hidden',
            )}
            style={{
              touchAction: isDrawing || isCropping ? 'none' : 'auto',
              cursor: isCropping ? 'crosshair' : isDrawing ? 'crosshair' : 'default',
            }}
            tabIndex={isCropping ? 0 : -1}
            aria-label={isCropping ? 'Crop image' : 'Image being edited'}
            aria-describedby={isCropping ? 'composer-image-crop-instructions' : undefined}
            onKeyDown={handleCropKeyDown}
            onPointerDown={beginStroke}
            onPointerMove={continueStroke}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
          />
          <p id="composer-image-crop-instructions" className="sr-only">
            Drag inside the crop area to move it or drag a corner to resize. Use arrow keys to move; hold Shift to resize.
          </p>
        </div>

        <footer className="flex min-h-16 shrink-0 items-center justify-center gap-2 border-t border-[color:var(--app-divider)] px-4 py-2">
          <button
            type="button"
            className="app-button-quiet inline-flex min-h-11 items-center gap-2 rounded-[10px] px-3 text-xs font-medium"
            onClick={rotateImage}
            disabled={!isReady || isFinishing}
            aria-label="Rotate image clockwise"
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            <span>Rotate</span>
          </button>
          <button
            type="button"
            className={cn(
              'app-button-quiet inline-flex min-h-11 items-center gap-2 rounded-[10px] px-3 text-xs font-medium',
              isCropping && 'app-control-chip-active',
            )}
            onClick={startCropping}
            disabled={!isReady || isFinishing}
            aria-label="Crop image"
            aria-pressed={isCropping}
          >
            <Crop className="h-4 w-4" aria-hidden="true" />
            <span>Crop</span>
          </button>
          <button
            type="button"
            className={cn(
              'app-button-quiet inline-flex min-h-11 items-center gap-2 rounded-[10px] px-3 text-xs font-medium',
              isDrawing && 'app-control-chip-active',
            )}
            onClick={toggleDrawing}
            disabled={!isReady || isFinishing}
            aria-label="Draw on image"
            aria-pressed={isDrawing}
          >
            <Paintbrush className="h-4 w-4" aria-hidden="true" />
            <span>Draw</span>
          </button>
          <button
            type="button"
            className="app-button-primary inline-flex min-h-11 items-center gap-2 rounded-[10px] px-4 text-xs font-semibold disabled:opacity-45"
            onClick={() => { void finishEditing(); }}
            disabled={!isReady || isFinishing}
            aria-label="Done editing image"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            <span>{isFinishing ? 'Applying…' : 'Done'}</span>
          </button>
        </footer>
        {error && isReady ? (
          <p className="shrink-0 px-4 pb-3 text-center text-xs text-rose-400" role="alert">{error}</p>
        ) : null}
      </div>
    </dialog>
  );
}
