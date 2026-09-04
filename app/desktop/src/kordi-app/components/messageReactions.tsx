import { useMemo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { EmojiPicker, EmojiPickerItemImage } from '@/features/emoji/EmojiPicker';
import {
  emojiItemFromReaction,
  emojiReactionValue,
  quickReactionEmojiItems,
  readRecentEmojiItems,
  recordRecentEmojiItem,
} from '@/features/emoji/emojiCatalog';
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
        const item = emojiItemFromReaction(reaction.value);
        return (
          <button
            key={reaction.value}
            type="button"
            className="app-message-reaction-chip"
            disabled={!onReactMessage}
            onClick={() => void onReactMessage?.(msg, reaction.value)}
            aria-label={`${item?.name ?? reaction.value} reaction, ${reaction.accountIds.length} people`}
          >
            {item
              ? <EmojiPickerItemImage item={item} decorative />
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
  const { recentItems, quickItems } = useMemo(() => {
    const recent = readRecentEmojiItems();
    return {
      recentItems: recent,
      quickItems: quickReactionEmojiItems(),
    };
  }, []);

  return (
    <div className={cn('app-message-reaction-surface app-transient-surface', expanded && 'app-message-reaction-surface-expanded')}>
      <div className="app-message-reaction-quick-row">
        {quickItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className="app-message-reaction-quick"
            aria-label={`React with ${item.name}`}
            title={item.name}
            onClick={() => {
              recordRecentEmojiItem(item);
              onReact(emojiReactionValue(item));
            }}
          >
            <EmojiPickerItemImage item={item} decorative />
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
        <EmojiPicker
          compact
          initialCategory={recentItems.length ? 'recent' : 'noto'}
          onSelect={(item) => onReact(emojiReactionValue(item))}
        />
      ) : null}
    </div>
  );
}
