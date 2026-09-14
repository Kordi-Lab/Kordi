import { memo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

import {
  getRemoteImageSnapshot,
  shouldLoadRemoteImageThroughNativeProxy,
  useRemoteImage,
} from '@/kordi-app/components/remoteAvatarImage';
import { cn } from '@/lib/utils';
import { isEmojiImageReady, markEmojiImageReady } from './emojiImageReadiness';
import { useNearEmojiViewport } from './emojiViewport';
import { notoEmojiAssetUrl, type NotoEmoji } from './notoEmoji';
import { notoThumbnailStyle } from './notoEmojiThumbnails';

function NotoFrame({ source, readinessKey, className, native, lazy = false, onError }: {
  source: string | null;
  readinessKey: string;
  className: string;
  native: boolean;
  lazy?: boolean;
  onError?: () => void;
}) {
  const [loadedSource, setLoadedSource] = useState<string | null>(() => (
    className === 'app-noto-still' && isEmojiImageReady(readinessKey) ? source : null
  ));
  return (
    <img
      src={source ?? undefined}
      className={className}
      alt=""
      data-ready={Boolean(source && loadedSource === source)}
      loading={native && !lazy ? 'eager' : 'lazy'}
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

function RemoteNotoStill({ emoji, native, nearViewport }: {
  emoji: NotoEmoji;
  native: boolean;
  nearViewport: boolean;
}) {
  const stillUrl = notoEmojiAssetUrl(emoji, 'png');
  const cachedStill = getRemoteImageSnapshot(stillUrl).status === 'ready';
  const still = useRemoteImage(stillUrl, native && (nearViewport || cachedStill));
  const source = native ? (still.status === 'ready' ? still.dataUrl : null) : stillUrl;
  return <>
    <NotoFrame key={stillUrl} source={source} readinessKey={`noto:${stillUrl}`} className="app-noto-still" native={native} lazy={cachedStill} />
    <span className="app-noto-fallback" aria-hidden="true">{emoji.value}</span>
  </>;
}

export const NotoEmojiImage = memo(function NotoEmojiImage({
  emoji,
  animated = true,
  thumbnail = false,
  className,
  decorative = false,
}: {
  emoji: NotoEmoji;
  animated?: boolean;
  thumbnail?: boolean;
  className?: string;
  decorative?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const imageRef = useRef<HTMLSpanElement | null>(null);
  const native = shouldLoadRemoteImageThroughNativeProxy(notoEmojiAssetUrl(emoji, 'png'));
  const nearViewport = useNearEmojiViewport(imageRef, native && (!thumbnail || animated));
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
      {thumbnail ? (
        <span className="app-noto-still app-noto-thumbnail" style={notoThumbnailStyle(emoji.id)} aria-hidden="true" />
      ) : (
        <RemoteNotoStill emoji={emoji} native={native} nearViewport={nearViewport} />
      )}
    </span>
  );
});
