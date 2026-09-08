import { memo, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

import {
  shouldLoadRemoteImageThroughNativeProxy,
  useRemoteImage,
} from '@/kordi-app/components/remoteAvatarImage';
import { cn } from '@/lib/utils';
import { blobEmojiAssetUrl, type BlobEmoji } from './blobEmoji';
import { isEmojiImageReady, markEmojiImageReady } from './emojiImageReadiness';
import { useNearEmojiViewport } from './emojiViewport';

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
  const nearViewport = useNearEmojiViewport(canvasRef, native);
  const { source } = useBlobEmojiSource(emoji, nearViewport);
  const readinessKey = `blob:${emoji.sha256}:still`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth || 128;
      canvas.height = image.naturalHeight || 128;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      markEmojiImageReady(readinessKey);
      setLoadedKey(readinessKey);
    };
    image.src = source;
    return () => { image.onload = null; };
  }, [readinessKey, source]);

  return (
    <canvas
      ref={canvasRef}
      className={cn('app-blob-emoji-image', className)}
      data-ready={source && loadedKey === readinessKey || undefined}
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
  const nearViewport = useNearEmojiViewport(imageRef, native);
  const { source } = useBlobEmojiSource(emoji, nearViewport);
  const readinessKey = `blob:${emoji.sha256}:animated`;
  const [loadedKey, setLoadedKey] = useState<string | null>(() => (
    isEmojiImageReady(readinessKey) ? readinessKey : null
  ));
  const ready = Boolean(source && (loadedKey === readinessKey || isEmojiImageReady(readinessKey)));
  return (
    <img
      ref={imageRef}
      src={source ?? undefined}
      className={cn('app-blob-emoji-image object-contain', className)}
      data-ready={ready || undefined}
      alt={decorative ? '' : emoji.id}
      aria-hidden={decorative || undefined}
      loading={native ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onLoad={() => {
        markEmojiImageReady(readinessKey);
        setLoadedKey(readinessKey);
      }}
    />
  );
}
