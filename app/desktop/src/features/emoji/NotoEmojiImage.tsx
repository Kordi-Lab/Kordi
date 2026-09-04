import { memo, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

import {
  shouldLoadRemoteImageThroughNativeProxy,
  useRemoteImage,
} from '@/kordi-app/components/remoteAvatarImage';
import { cn } from '@/lib/utils';
import { useNearEmojiViewport } from './emojiViewport';
import { notoEmojiAssetUrl, type NotoEmoji } from './notoEmoji';

export const NotoEmojiImage = memo(function NotoEmojiImage({
  emoji,
  animated = true,
  className,
  decorative = false,
}: {
  emoji: NotoEmoji;
  animated?: boolean;
  className?: string;
  decorative?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const shouldAnimate = animated && !reduceMotion;
  const requestKey = `${emoji.id}:${shouldAnimate}`;
  const [failedWebpKey, setFailedWebpKey] = useState<string | null>(null);
  const format = shouldAnimate ? (failedWebpKey === requestKey ? 'gif' : 'webp') : 'png';
  const remoteUrl = notoEmojiAssetUrl(emoji, format);
  const native = shouldLoadRemoteImageThroughNativeProxy(remoteUrl);
  const nearViewport = useNearEmojiViewport(imageRef, native);
  const remote = useRemoteImage(remoteUrl, native && nearViewport);
  const source = native ? (remote.status === 'ready' ? remote.dataUrl : null) : remoteUrl;
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const ready = Boolean(source && source === loadedSource && source !== failedSource);
  const failed = native
    ? format !== 'webp' && remote.status === 'failed'
    : Boolean(source && source === failedSource);

  useEffect(() => {
    if (format === 'webp' && native && remote.status === 'failed') {
      setFailedWebpKey(requestKey);
    }
  }, [format, native, remote.status, requestKey]);

  return (
    <span
      className={cn('app-noto-emoji', className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : emoji.name}
      aria-hidden={decorative || undefined}
      data-loading={(!ready && !failed) || undefined}
    >
      {failed ? <span aria-hidden="true">{emoji.value}</span> : null}
      <img
        ref={imageRef}
        src={source ?? undefined}
        alt=""
        data-ready={ready}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => {
          setLoadedSource(source);
          setFailedSource(null);
        }}
        onError={() => {
          if (format === 'webp') setFailedWebpKey(requestKey);
          else setFailedSource(source);
        }}
      />
    </span>
  );
});
