import { Check, CheckCheck, LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  formatAttachmentSize,
  type AttachmentImageDeliveryVisual,
} from './transcriptAttachmentTypes';

type TranscriptImageDeliveryOverlayProps = {
  visual: AttachmentImageDeliveryVisual | null;
  time?: string | null;
  foregroundTone: 'light' | 'dark' | null;
  onRetry?: () => void;
  uploadProgress?: number | null;
  uploadedBytes?: number | null;
  totalBytes?: number | null;
  onCancelUpload?: () => void;
  mediaLabel?: string;
};

function adaptiveDeliveryOverlayClassName(foregroundTone: 'light' | 'dark' | null) {
  return cn(
    'app-attachment-image-delivery-overlay',
    foregroundTone
      ? `app-attachment-image-delivery-foreground-${foregroundTone}`
      : 'app-attachment-image-delivery-adaptive',
  );
}

export function TranscriptImageDeliveryOverlay({
  visual,
  time,
  foregroundTone,
  onRetry,
  uploadProgress = null,
  uploadedBytes = null,
  totalBytes = null,
  onCancelUpload,
  mediaLabel = 'image',
}: TranscriptImageDeliveryOverlayProps) {
  if (!visual) return null;

  if (visual.kind === 'uploading') {
    const progress = uploadProgress === null
      ? null
      : Math.max(0, Math.min(100, Math.floor(uploadProgress)));
    const uploadedSize = formatAttachmentSize(uploadedBytes);
    const totalSize = formatAttachmentSize(totalBytes);
    const sizeProgress = uploadedSize && totalSize ? `${uploadedSize} / ${totalSize}` : null;
    const ring = (
      <div className="app-attachment-image-media-ring-spinner" data-determinate={progress !== null}>
        <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
          <circle className="app-attachment-image-media-ring-track" cx="16" cy="16" r="12.5" />
          <circle
            className="app-attachment-image-media-ring-progress"
            cx="16"
            cy="16"
            r="12.5"
            style={progress === null ? undefined : {
              strokeDasharray: 78.54,
              strokeDashoffset: 78.54 * (1 - progress / 100),
            }}
          />
        </svg>
        {progress === null ? null : <span className="app-attachment-image-media-ring-label">{progress}%</span>}
      </div>
    );
    return (
      <div
        data-attachment-image-delivery-status="uploading"
        className={adaptiveDeliveryOverlayClassName(foregroundTone)}
        role="status"
        aria-label={progress === null ? visual.label : `${visual.label}, ${progress}%, ${sizeProgress ?? ''}`.replace(/, $/, '')}
      >
        {sizeProgress ? <span className="app-attachment-media-upload-size">{sizeProgress}</span> : null}
        <div className="app-attachment-image-media-ring">
          {onCancelUpload ? (
            <button
              type="button"
              className="app-attachment-image-media-ring-cancel"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCancelUpload();
              }}
              aria-label={`Cancel ${mediaLabel} upload`}
            >
              {ring}
            </button>
          ) : ring}
        </div>
      </div>
    );
  }

  if (visual.kind === 'delivering') {
    return (
      <div
        data-attachment-image-delivery-status="delivering"
        className={adaptiveDeliveryOverlayClassName(foregroundTone)}
        role="status"
        aria-label={visual.label}
      >
        <div className="app-attachment-image-delivery-meta">
          <span className="app-attachment-image-delivery-spinner" aria-hidden="true">
            <LoaderCircle className="h-3 w-3" />
          </span>
          <span>Delivering…</span>
        </div>
      </div>
    );
  }

  if (visual.kind === 'failed' || visual.kind === 'partial') {
    return (
      <div
        data-attachment-image-delivery-status={visual.kind}
        className="app-attachment-image-delivery-overlay"
        role="status"
        aria-label={visual.label}
        title={visual.label}
      >
        <div className="app-attachment-image-delivery-meta app-attachment-image-delivery-error">
          {onRetry ? (
            <button
              type="button"
              className="app-attachment-image-delivery-retry"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRetry();
              }}
              aria-label={`Retry sending ${mediaLabel}`}
            >
              <span>{visual.kind === 'partial' ? 'Partial' : 'Failed'}</span>
              <span aria-hidden="true">·</span>
              <span className="app-attachment-image-delivery-retry-action">Retry</span>
            </button>
          ) : (
            <span>{visual.kind === 'partial' ? 'Partially delivered' : 'Failed'}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-attachment-image-delivery-status={visual.kind}
      className={adaptiveDeliveryOverlayClassName(foregroundTone)}
      role="status"
      aria-label={visual.label}
    >
      <div className="app-attachment-image-delivery-meta">
        {time ? <span>{time}</span> : null}
        {visual.kind === 'read'
          ? <CheckCheck className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
          : <Check className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />}
      </div>
    </div>
  );
}
