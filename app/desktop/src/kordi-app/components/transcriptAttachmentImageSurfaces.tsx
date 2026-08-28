import type { CSSProperties } from 'react';
import { Image, LoaderCircle } from 'lucide-react';

import { displayAttachmentName } from '@/features/chat/composerAttachments';
import { cn } from '@/lib/utils';
import type { MessageAttachment } from '../types';
import { AttachmentActions } from './transcriptAttachmentActions';

export function AttachmentImageLoadingSurface({
  className,
  style,
  transparent = false,
}: {
  className?: string;
  style?: CSSProperties;
  transparent?: boolean;
}) {
  return (
    <div
      data-attachment-image-loading="true"
      aria-label="Loading attached image"
      className={cn(
        'relative flex h-full min-h-28 aspect-[4/3] items-center justify-center overflow-hidden',
        style && 'h-auto min-h-0 aspect-auto',
        transparent ? 'bg-transparent' : 'bg-black/[0.035]',
        className,
      )}
      style={style}
    >
      {transparent ? (
        <LoaderCircle className="h-6 w-6 text-[color:var(--utility-muted-text)] motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.10)_42%,transparent_74%)] opacity-70 motion-safe:animate-[app-attachment-shimmer_1.45s_ease-in-out_infinite]" aria-hidden="true" />
      )}
      <span className="sr-only">Loading attached image</span>
    </div>
  );
}

export function AttachmentImageUnavailableSurface({ attachment, className, style }: {
  attachment: MessageAttachment;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      data-attachment-image-unavailable="true"
      className={cn(
        'app-attachment-image-fallback flex h-full min-h-28 aspect-[4/3] items-center gap-3 bg-black/[0.045] px-3 py-2.5',
        style && 'h-auto min-h-0 aspect-auto',
        className,
      )}
      style={style}
      role="status"
    >
      <div className="app-attachment-image-fallback-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-black/[0.06]">
        <Image className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="app-attachment-image-fallback-title truncate text-[12px] font-medium">{displayAttachmentName(attachment.name, attachment.kind)}</div>
        <div className="app-attachment-image-fallback-name mt-0.5 text-[10px] font-medium">Preview unavailable</div>
      </div>
      <AttachmentActions attachment={attachment} />
    </div>
  );
}
