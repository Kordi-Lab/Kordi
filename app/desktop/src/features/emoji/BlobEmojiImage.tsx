import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { useReducedMotion } from 'framer-motion';

import {
  shouldLoadRemoteImageThroughNativeProxy,
  useRemoteImage,
} from '@/kordi-app/components/remoteAvatarImage';
import { cn } from '@/lib/utils';
import { blobEmojiAssetUrl, type BlobEmoji } from './blobEmoji';

const nearViewportListeners = new Map<Element, () => void>();
let nearViewportObserver: IntersectionObserver | null = null;

function observeNearViewport(element: Element, listener: () => void) {
  if (typeof IntersectionObserver === 'undefined') {
    listener();
    return () => {};
  }
  nearViewportObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      nearViewportObserver?.unobserve(entry.target);
      nearViewportListeners.get(entry.target)?.();
      nearViewportListeners.delete(entry.target);
    }
  }, { rootMargin: '240px' });
  nearViewportListeners.set(element, listener);
  nearViewportObserver.observe(element);
  return () => {
    nearViewportObserver?.unobserve(element);
    nearViewportListeners.delete(element);
  };
}

function useNearViewport(ref: RefObject<Element | null>, enabled: boolean) {
  const [nearViewport, setNearViewport] = useState(!enabled);
  useEffect(() => {
    if (!enabled || nearViewport || !ref.current) return;
    return observeNearViewport(ref.current, () => setNearViewport(true));
  }, [enabled, nearViewport, ref]);
  return nearViewport;
}

function useBlobEmojiSource(emoji: BlobEmoji, nearViewport: boolean) {
  const remoteUrl = blobEmojiAssetUrl(emoji);
  const native = shouldLoadRemoteImageThroughNativeProxy(remoteUrl, undefined, true);
  const remote = useRemoteImage(remoteUrl, native && nearViewport, {
    command: 'desktop_fetch_blob_emoji_data_url',
    expectedSha256: emoji.sha256,
  });
  return {
    native,
    source: native ? (remote.status === 'ready' ? remote.dataUrl : null) : remoteUrl,
  };
}

function ReducedMotionBlobEmoji({
  emoji,
  className,
  decorative,
}: {
  emoji: BlobEmoji;
  className?: string;
  decorative: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const remoteUrl = blobEmojiAssetUrl(emoji);
  const native = shouldLoadRemoteImageThroughNativeProxy(remoteUrl, undefined, true);
  const nearViewport = useNearViewport(canvasRef, native);
  const { source } = useBlobEmojiSource(emoji, nearViewport);

  useEffect(() => {
    if (!source) return;
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth || 128;
      canvas.height = image.naturalHeight || 128;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
    };
    image.src = source;
    return () => { image.onload = null; };
  }, [source]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : emoji.id}
      aria-hidden={decorative || undefined}
    />
  );
}

export const BlobEmojiImage = memo(function BlobEmojiImage({
  emoji,
  className,
  decorative = false,
}: {
  emoji: BlobEmoji;
  className?: string;
  decorative?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  if (emoji.animated && reduceMotion) {
    return (
      <ReducedMotionBlobEmoji
        emoji={emoji}
        className={className}
        decorative={decorative}
      />
    );
  }
  return (
    <LoadedBlobEmojiImage
      emoji={emoji}
      className={className}
      decorative={decorative}
    />
  );
});

function LoadedBlobEmojiImage({
  emoji,
  className,
  decorative,
}: {
  emoji: BlobEmoji;
  className?: string;
  decorative: boolean;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const remoteUrl = blobEmojiAssetUrl(emoji);
  const native = shouldLoadRemoteImageThroughNativeProxy(remoteUrl, undefined, true);
  const nearViewport = useNearViewport(imageRef, native);
  const { source } = useBlobEmojiSource(emoji, nearViewport);
  return (
    <img
      ref={imageRef}
      src={source ?? undefined}
      className={cn('object-contain', className)}
      alt={decorative ? '' : emoji.id}
      aria-hidden={decorative || undefined}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}
