import { Check, CheckCheck, LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

type DeliveryVisual = {
  kind: 'uploading' | 'delivering' | 'sent' | 'delivered' | 'read' | 'partial' | 'failed';
  label: string;
};

type TranscriptImageDeliveryOverlayProps = {
  visual: DeliveryVisual | null;
  time?: string | null;
  foregroundTone: 'light' | 'dark' | null;
  onRetry?: () => void;
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
}: TranscriptImageDeliveryOverlayProps) {
  if (!visual) return null;

  if (visual.kind === 'uploading') {
    return (
      <div
        data-attachment-image-delivery-status="uploading"
        className={adaptiveDeliveryOverlayClassName(foregroundTone)}
        role="status"
        aria-label={visual.label}
      >
        <div className="app-attachment-image-media-ring" aria-hidden="true">
          <div className="app-attachment-image-media-ring-spinner">
            <svg viewBox="0 0 32 32" focusable="false">
              <circle className="app-attachment-image-media-ring-track" cx="16" cy="16" r="12.5" />
              <circle className="app-attachment-image-media-ring-progress" cx="16" cy="16" r="12.5" />
            </svg>
          </div>
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
              aria-label="Retry sending image"
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
