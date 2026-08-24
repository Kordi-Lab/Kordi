import { useMemo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { BlobEmojiImage } from '@/features/emoji/BlobEmojiImage';
import { BlobEmojiPicker } from '@/features/emoji/BlobEmojiPicker';
import {
  blobEmojiById,
  blobEmojiCatalog,
  blobEmojiFromReaction,
  blobEmojiReactionValue,
  readRecentBlobEmojiIDs,
  recordRecentBlobEmoji,
} from '@/features/emoji/blobEmoji';
import { cn } from '@/lib/utils';
import type { Message } from '../types';

export function MessageReactionChips({
  msg,
  onReactMessage,
  side,
}: {
  msg: Message;
  onReactMessage?: (message: Message, reaction: string) => Promise<void> | void;
  side: 'own' | 'peer' | 'standalone';
}) {
  if (!msg.reactions?.length) return null;
  return (
    <div className={cn('app-message-reaction-chips', `app-message-reaction-chips-${side}`)} aria-label="Message reactions">
      {msg.reactions.map((reaction) => {
        const emoji = blobEmojiFromReaction(reaction.value);
        return (
          <button
            key={reaction.value}
            type="button"
            className="app-message-reaction-chip"
            disabled={!onReactMessage}
            onClick={() => void onReactMessage?.(msg, reaction.value)}
            aria-label={`${emoji?.id ?? reaction.value} reaction, ${reaction.accountIds.length} people`}
          >
            {emoji
              ? <BlobEmojiImage emoji={emoji} decorative />
              : <span>{reaction.value}</span>}
            <span>{reaction.accountIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}

export function MessageReactionSurface({
  expanded,
  onReact,
  onToggleExpanded,
}: {
  expanded: boolean;
  onReact: (reaction: string) => void;
  onToggleExpanded: () => void;
}) {
  const { recentReactions, quickReactions } = useMemo(() => {
    const recent = readRecentBlobEmojiIDs().flatMap((id) => blobEmojiById.get(id) ?? []);
    const recentIDs = new Set(recent.map((emoji) => emoji.id));
    const fallback = blobEmojiCatalog.filter((emoji) => !emoji.animated);
    return {
      recentReactions: recent,
      quickReactions: [...recent, ...fallback.filter((emoji) => !recentIDs.has(emoji.id))].slice(0, 6),
    };
  }, []);

  return (
    <div className={cn('app-message-reaction-surface app-transient-surface', expanded && 'app-message-reaction-surface-expanded')}>
      <div className="app-message-reaction-quick-row">
        {quickReactions.map((emoji) => (
          <button
            key={emoji.id}
            type="button"
            className="app-message-reaction-quick"
            aria-label={`React with ${emoji.id}`}
            title={emoji.id}
            onClick={() => {
              recordRecentBlobEmoji(emoji.id);
              onReact(blobEmojiReactionValue(emoji));
            }}
          >
            <BlobEmojiImage emoji={emoji} decorative />
          </button>
        ))}
        <button
          type="button"
          className="app-message-reaction-expand"
          aria-label={expanded ? 'Collapse reaction picker' : 'Show all reactions'}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      </div>
      {expanded ? (
        <BlobEmojiPicker
          compact
          initialCategory={recentReactions.length ? 'recent' : 'all'}
          onSelect={(emoji) => onReact(blobEmojiReactionValue(emoji))}
        />
      ) : null}
    </div>
  );
}
