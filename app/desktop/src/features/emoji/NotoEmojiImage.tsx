import { memo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

import {
  shouldLoadRemoteImageThroughNativeProxy,
  useRemoteImage,
} from '@/kordi-app/components/remoteAvatarImage';
import { cn } from '@/lib/utils';
import { markEmojiImageReady } from './emojiImageReadiness';
import { useNearEmojiViewport } from './emojiViewport';
import { notoEmojiAssetUrl, type NotoEmoji } from './notoEmoji';

function NotoFrame({ source, readinessKey, className, native, onError }: {
  source: string | null;
  readinessKey: string;
  className: string;
  native: boolean;
  onError?: () => void;
}) {
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  return (
    <img
      src={source ?? undefined}
      className={className}
      alt=""
      data-ready={Boolean(source && loadedSource === source)}
      loading={native ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onLoad={() => {
        markEmojiImageReady(readinessKey);
        setLoadedSource(source);
      }}
      onError={() => {
        setLoadedSource(null);
        onError?.();
      }}
    />
  );
}

function NotoAnimation({ emoji, nearViewport, native }: {
  emoji: NotoEmoji;
  nearViewport: boolean;
  native: boolean;
}) {
  const [failedWebp, setFailedWebp] = useState(false);
  const webpUrl = notoEmojiAssetUrl(emoji, 'webp');
  const webp = useRemoteImage(webpUrl, native && nearViewport);
  const useGif = failedWebp || (native && webp.status === 'failed');
  const gifUrl = notoEmojiAssetUrl(emoji, 'gif');
  const gif = useRemoteImage(gifUrl, native && nearViewport && useGif);
  const remoteUrl = useGif ? gifUrl : webpUrl;
  const remote = useGif ? gif : webp;
  const source = native ? (remote.status === 'ready' ? remote.dataUrl : null) : remoteUrl;
  return (
    <NotoFrame
      source={source}
      readinessKey={`noto:${remoteUrl}`}
      className="app-noto-animation"
      native={native}
      onError={() => { if (!useGif) setFailedWebp(true); }}
    />
  );
}

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
  const imageRef = useRef<HTMLSpanElement | null>(null);
  const stillUrl = notoEmojiAssetUrl(emoji, 'png');
  const native = shouldLoadRemoteImageThroughNativeProxy(stillUrl);
  const nearViewport = useNearEmojiViewport(imageRef, native);
  const still = useRemoteImage(stillUrl, native && nearViewport);
  const stillSource = native ? (still.status === 'ready' ? still.dataUrl : null) : stillUrl;
  return (
    <span
      ref={imageRef}
      className={cn('app-noto-emoji', className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : emoji.name}
      aria-hidden={decorative || undefined}
    >
      {animated && !reduceMotion ? (
        <NotoAnimation key={emoji.id} emoji={emoji} native={native} nearViewport={nearViewport} />
      ) : null}
      <NotoFrame source={stillSource} readinessKey={`noto:${stillUrl}`} className="app-noto-still" native={native} />
      <span className="app-noto-fallback" aria-hidden="true">{emoji.value}</span>
    </span>
  );
});
