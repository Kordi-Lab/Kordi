import { useEffect, useState } from 'react';
import type { ProviderMediaMessageBlock, StructuredMessageContent, StructuredMessageInlineNode } from '@/kordi-app/types';
import { useCloudCustomEmojiAsset } from './cloudCustomEmojis';
import { giphyConfigured, lookupGiphyMedia, type GiphyProviderMedia } from './giphyProvider';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeStructuredMessageContent(value: unknown): StructuredMessageContent | null {
  const root = record(value);
  if (root?.schema !== 1 || !Array.isArray(root.blocks)) return null;
  const blocks: StructuredMessageContent['blocks'] = [];
  for (const candidate of root.blocks) {
    const block = record(candidate);
    if (
      block?.type === 'provider_media'
      && block.provider === 'giphy'
      && typeof block.providerMediaId === 'string'
      && (block.mediaKind === 'gif' || block.mediaKind === 'sticker')
      && typeof block.title === 'string'
      && typeof block.altText === 'string'
      && typeof block.width === 'number'
      && typeof block.height === 'number'
      && typeof block.rating === 'string'
    ) {
      blocks.push({
        type: 'provider_media',
        provider: 'giphy',
        providerMediaId: block.providerMediaId,
        mediaKind: block.mediaKind,
        title: block.title,
        altText: block.altText,
        width: block.width,
        height: block.height,
        rating: block.rating,
      });
      continue;
    }
    if (block?.type !== 'paragraph' || !Array.isArray(block.children)) return null;
    const children: StructuredMessageInlineNode[] = [];
    for (const childCandidate of block.children) {
      const child = record(childCandidate);
      if (child?.type === 'text' && typeof child.text === 'string') {
        children.push({ type: 'text', text: child.text });
      } else if (
        child?.type === 'custom_emoji'
        && typeof child.emojiId === 'string'
        && typeof child.fallback === 'string'
      ) {
        children.push({
          type: 'custom_emoji',
          emojiId: child.emojiId,
          fallback: child.fallback,
        });
      } else {
        return null;
      }
    }
    blocks.push({ type: 'paragraph', children });
  }
  return blocks.length > 0 ? { schema: 1, blocks } : null;
}

function ProviderMediaBlock({ block }: { block: ProviderMediaMessageBlock }) {
  const [media, setMedia] = useState<GiphyProviderMedia | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let active = true;
    if (!giphyConfigured()) {
      setUnavailable(true);
      return () => { active = false; };
    }
    void lookupGiphyMedia(block.providerMediaId, block.mediaKind)
      .then((result) => {
        if (!active) return;
        setMedia(result);
        setUnavailable(!result);
      })
      .catch(() => { if (active) setUnavailable(true); });
    return () => { active = false; };
  }, [block.mediaKind, block.providerMediaId]);

  if (unavailable) {
    return (
      <span className="block rounded-xl border border-[color:var(--app-divider)] px-3 py-2 text-xs text-[color:var(--utility-muted-text)]">
        This {block.mediaKind === 'gif' ? 'GIF' : 'sticker'} is no longer available.
      </span>
    );
  }
  if (!media) return <span className="block h-32 w-56 animate-pulse rounded-xl bg-black/10" aria-label={`Loading ${block.mediaKind}`} />;
  const isVideo = /\.mp4(?:\?|$)/i.test(media.playbackUrl);
  return (
    <span className="block max-w-[400px] overflow-hidden rounded-xl border border-black/10 bg-black/5">
      {reduceMotion ? (
        <img
          src={media.previewUrl}
          alt={block.altText}
          className="block max-h-[360px] w-full object-contain"
          draggable={false}
        />
      ) : isVideo ? (
        <video
          src={media.playbackUrl}
          aria-label={block.altText}
          autoPlay
          loop
          muted
          playsInline
          className="block max-h-[360px] w-full object-contain"
        />
      ) : (
        <img
          src={media.playbackUrl}
          alt={block.altText}
          className="block max-h-[360px] w-full object-contain"
          draggable={false}
        />
      )}
      <span className="flex items-center justify-between gap-3 px-2 py-1 text-[9px] text-[color:var(--utility-muted-text)]">
        <span className="truncate">{block.title}</span>
        <span className="shrink-0 font-semibold">Powered by GIPHY</span>
      </span>
    </span>
  );
}

function CustomEmojiInline({ emojiId, fallback }: { emojiId: string; fallback: string }) {
  const assetUrl = useCloudCustomEmojiAsset(emojiId);
  if (!assetUrl) return <span className="font-medium">{fallback}</span>;
  return (
    <img
      src={assetUrl}
      alt={fallback}
      title={fallback}
      className="mx-0.5 inline-block h-[1.45em] w-[1.45em] align-[-0.28em] object-contain"
      draggable={false}
    />
  );
}

export function StructuredMessageContentView({
  content,
  fallbackText,
}: {
  content: StructuredMessageContent | null | undefined;
  fallbackText: string;
}) {
  if (!content) return <>{fallbackText}</>;
  return (
    <>
      {content.blocks.map((block, blockIndex) => (
        block.type === 'provider_media'
          ? <ProviderMediaBlock key={`${block.provider}:${block.providerMediaId}:${blockIndex}`} block={block} />
          : (
              <span key={blockIndex} className="whitespace-pre-wrap break-words">
                {block.children.map((child, childIndex) => child.type === 'text'
                  ? <span key={childIndex}>{child.text}</span>
                  : <CustomEmojiInline key={`${child.emojiId}:${childIndex}`} emojiId={child.emojiId} fallback={child.fallback} />)}
                {blockIndex < content.blocks.length - 1 ? '\n' : null}
              </span>
            )
      ))}
    </>
  );
}
