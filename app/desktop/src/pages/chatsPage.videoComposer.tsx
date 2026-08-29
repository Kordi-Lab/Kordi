import { useEffect, useRef, useState } from 'react';
import { Camera, CircleStop, LoaderCircle, RotateCcw, Send, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { AppDialog, AppDialogTitle } from '@/components/ui/dialog';
import {
  attachmentVideoDisplaySize,
  attachmentVideoUrl,
} from '@/features/chat/attachmentMediaGallery';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import {
  formatVideoRecordingDuration,
  type VideoMessageRecorderController,
} from '@/features/chat/useVideoMessageRecorder';
import {
  captureVideoPosterDataUrl,
  captureVideoPreview,
} from '@/features/chat/composerAttachments';

export function VideoRecordingSurface({ video }: { video: VideoMessageRecorderController }) {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const { state } = video;

  useEffect(() => {
    const element = previewRef.current;
    if (element) element.srcObject = state.stream;
    return () => {
      if (element) element.srcObject = null;
    };
  }, [state.stream]);

  if (state.phase === 'recording') {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-2 py-1" data-video-recording-surface="recording">
        <div className="relative max-h-[260px] overflow-hidden rounded-[14px] bg-black">
          <video ref={previewRef} autoPlay muted playsInline className="block max-h-[260px] w-full object-contain" aria-label="Live camera preview" />
          <span className="absolute left-2.5 top-2.5 rounded-full bg-black/65 px-2 py-1 text-[11px] font-semibold tabular-nums text-white" aria-live="off">
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
            {formatVideoRecordingDuration(state.durationMs)} / 1:00
          </span>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="quiet" size="sm" onClick={video.reset}>
            <X className="mr-1.5 h-4 w-4" aria-hidden="true" />Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => video.stop(captureVideoPosterDataUrl(previewRef.current))}
          >
            <CircleStop className="mr-1.5 h-4 w-4" aria-hidden="true" />Stop
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === 'review') {
    if (!state.attachment) return null;
    return (
      <VideoReviewSurface
        attachment={state.attachment}
        error={state.error}
        onCancel={video.reset}
        onRetake={() => { void video.retake(); }}
        onSend={() => video.send()}
        dataAttribute="recording"
      />
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3 py-2" data-video-recording-surface="error" role="alert">
        <Camera className="h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[12px] leading-5 text-[color:var(--utility-foreground)]">{state.error}</p>
        <Button type="button" variant="quiet" size="sm" onClick={video.reset}>Cancel</Button>
        <Button type="button" size="sm" onClick={() => { void video.start(); }}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-16 flex-1 items-center justify-center gap-2 py-3 text-[12px] text-[color:var(--utility-muted-text)]" role="status">
      <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {state.phase === 'requesting' ? 'Starting camera…' : 'Preparing video…'}
      <Button type="button" variant="quiet" size="sm" onClick={video.reset}>Cancel</Button>
    </div>
  );
}

export function VideoAttachmentReviewSurface({
  attachment,
  onCancel,
  onSend,
}: {
  attachment: AttachmentItem;
  onCancel: () => void;
  onSend: (attachment: AttachmentItem, caption: string) => void;
}) {
  const [caption, setCaption] = useState('');
  const titleId = 'video-attachment-review-title';
  return (
    <AppDialog
      titleId={titleId}
      onDismiss={onCancel}
      className="w-[min(680px,calc(100vw-2rem))] max-w-none overflow-hidden rounded-[24px] p-0"
    >
      <header className="app-transient-divider flex items-center justify-between border-b px-5 py-4">
        <AppDialogTitle id={titleId}>Send a video file</AppDialogTitle>
        <button
          type="button"
          className="app-button-quiet grid h-8 w-8 place-items-center rounded-full"
          onClick={onCancel}
          aria-label="Close video review"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      <VideoReviewSurface
        attachment={attachment}
        onCancel={onCancel}
        onSend={onSend}
        dataAttribute="attachment"
        caption={caption}
        onCaptionChange={setCaption}
      />
    </AppDialog>
  );
}

function VideoReviewSurface({
  attachment,
  error,
  onCancel,
  onRetake,
  onSend,
  dataAttribute,
  caption = '',
  onCaptionChange,
}: {
  attachment: AttachmentItem;
  error?: string | null;
  onCancel: () => void;
  onRetake?: () => void;
  onSend: (attachment: AttachmentItem, caption: string) => void;
  dataAttribute: 'attachment' | 'recording';
  caption?: string;
  onCaptionChange?: (value: string) => void;
}) {
  const [preparedAttachment, setPreparedAttachment] = useState(attachment);
  const source = attachmentVideoUrl(preparedAttachment);
  const displaySize = attachmentVideoDisplaySize(preparedAttachment);
  const posterReady = preparedAttachment.previewUrl?.startsWith('data:image/') === true;
  const [playbackState, setPlaybackState] = useState<'loading' | 'ready' | 'error'>(
    source ? 'loading' : 'error',
  );

  return (
    <div
      className={dataAttribute === 'attachment'
        ? 'flex min-w-0 flex-1 flex-col gap-3 p-5'
        : 'flex min-w-0 flex-1 flex-col gap-2 py-1'}
      data-video-review-surface={dataAttribute}
    >
      <div
        className="relative mx-auto max-w-full overflow-hidden rounded-[16px] bg-black"
        style={{ width: displaySize.width, maxWidth: 'min(100%, 70vw)' }}
      >
        <video
          src={source}
          poster={preparedAttachment.previewUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
          className="block w-full bg-black object-contain"
          style={{ aspectRatio: `${displaySize.width} / ${displaySize.height}` }}
          aria-label={`Review ${attachment.name}`}
          onLoadedMetadata={() => setPlaybackState('ready')}
          onLoadedData={(event) => {
            if (posterReady) return;
            const preview = captureVideoPreview(event.currentTarget);
            if (!preview) return;
            setPreparedAttachment((current) => ({
              ...current,
              previewUrl: preview.previewUrl,
              widthPixels: preview.widthPixels,
              heightPixels: preview.heightPixels,
            }));
          }}
          onError={() => setPlaybackState('error')}
        />
        {playbackState === 'loading' ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center" role="status" aria-label="Preparing video preview">
            <LoaderCircle className="h-7 w-7 animate-spin text-white motion-reduce:animate-none" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      {playbackState === 'error' || error ? (
        <p className="text-[11px] text-red-500" role="alert">
          {error ?? 'This video could not be played. Choose another MP4 file.'}
        </p>
      ) : !posterReady ? (
        <p className="text-[11px] text-[color:var(--utility-muted-text)]" role="status">
          Preparing video poster…
        </p>
      ) : null}
      {onCaptionChange ? (
        <label className="grid gap-1.5">
          <span className="text-[11px] font-medium text-[color:var(--utility-muted-text)]">Caption</span>
          <textarea
            value={caption}
            onChange={(event) => onCaptionChange(event.target.value)}
            rows={2}
            className="min-h-[56px] resize-none rounded-[12px] border border-[color:var(--app-transient-border)] bg-[color:var(--app-transient-raised-bg)] px-3 py-2 text-[13px] text-[color:var(--utility-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-sidebar-accent)]"
            placeholder="Add a caption…"
          />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="quiet" size="sm" onClick={onCancel}>
          <X className="mr-1.5 h-4 w-4" aria-hidden="true" />Cancel
        </Button>
        {onRetake ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetake}>
            <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden="true" />Retake
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={() => onSend(preparedAttachment, caption)}
          disabled={playbackState !== 'ready' || !posterReady}
        >
          <Send className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Send video
        </Button>
      </div>
    </div>
  );
}
