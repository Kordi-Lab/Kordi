import { memo, useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';

import { cn } from '@/lib/utils';
import { blobEmojiAssetUrl, type BlobEmoji } from './blobEmoji';

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

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth || 128;
      canvas.height = image.naturalHeight || 128;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
    };
    image.src = blobEmojiAssetUrl(emoji);
    return () => { image.onload = null; };
  }, [emoji]);

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
    <img
      src={blobEmojiAssetUrl(emoji)}
      className={cn('object-contain', className)}
      alt={decorative ? '' : emoji.id}
      aria-hidden={decorative || undefined}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
});
