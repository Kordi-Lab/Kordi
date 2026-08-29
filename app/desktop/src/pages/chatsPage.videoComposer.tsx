import { useEffect, useRef } from 'react';
import { Camera, CircleStop, LoaderCircle, RotateCcw, Send, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { attachmentVideoUrl } from '@/features/chat/attachmentMediaGallery';
import {
  formatVideoRecordingDuration,
  type VideoMessageRecorderController,
} from '@/features/chat/useVideoMessageRecorder';
import { captureVideoPosterDataUrl } from '@/features/chat/composerAttachments';

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
    const source = state.attachment ? attachmentVideoUrl(state.attachment) : undefined;
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-2 py-1" data-video-recording-surface="review">
        <div className="mx-auto w-full max-w-[520px] overflow-hidden rounded-[16px] bg-black/[0.92] text-white">
          <video
            src={source}
            poster={state.attachment?.previewUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="block aspect-video max-h-[360px] w-full bg-black object-contain"
            aria-label="Review recorded video"
          />
          <div className="flex h-10 min-w-0 items-center border-t border-white/10 px-3">
            <span className="truncate text-[10.5px] font-medium text-white/75">
              {state.attachment?.name}
            </span>
          </div>
        </div>
        {state.error ? <p className="text-[11px] text-red-500" role="alert">{state.error}</p> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="quiet" size="sm" onClick={video.reset}>
            <X className="mr-1.5 h-4 w-4" aria-hidden="true" />Cancel
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { void video.retake(); }}>
            <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden="true" />Retake
          </Button>
          <Button type="button" size="sm" onClick={video.send}>
            <Send className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Send video
          </Button>
        </div>
      </div>
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
