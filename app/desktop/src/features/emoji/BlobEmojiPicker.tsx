import { useMemo, useState } from 'react';
import { Clock3, Film, Grid3X3, Image as ImageIcon, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { BlobEmojiImage } from './BlobEmojiImage';
import {
  blobEmojiById,
  blobEmojiCatalog,
  readRecentBlobEmojiIDs,
  recordRecentBlobEmoji,
  type BlobEmoji,
} from './blobEmoji';

type BlobEmojiCategory = 'recent' | 'all' | 'animated' | 'static';

const categories = [
  { id: 'recent', label: 'Recent', icon: Clock3 },
  { id: 'all', label: 'All', icon: Grid3X3 },
  { id: 'animated', label: 'Animated', icon: Film },
  { id: 'static', label: 'Static', icon: ImageIcon },
] satisfies Array<{ id: BlobEmojiCategory; label: string; icon: typeof Clock3 }>;

export function BlobEmojiPicker({
  onSelect,
  compact = false,
  initialCategory = 'all',
}: {
  onSelect: (emoji: BlobEmoji) => void;
  compact?: boolean;
  initialCategory?: BlobEmojiCategory;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<BlobEmojiCategory>(initialCategory);
  const [recentIDs, setRecentIDs] = useState(() => readRecentBlobEmojiIDs());
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery) {
      return blobEmojiCatalog.filter((emoji) => emoji.id.toLocaleLowerCase().includes(normalizedQuery));
    }
    if (category === 'recent') return recentIDs.flatMap((id) => blobEmojiById.get(id) ?? []);
    if (category === 'animated') return blobEmojiCatalog.filter((emoji) => emoji.animated);
    if (category === 'static') return blobEmojiCatalog.filter((emoji) => !emoji.animated);
    return blobEmojiCatalog;
  }, [category, query, recentIDs]);

  const select = (emoji: BlobEmoji) => {
    setRecentIDs(recordRecentBlobEmoji(emoji.id));
    onSelect(emoji);
  };

  return (
    <div className={cn('app-blob-emoji-picker', compact && 'app-blob-emoji-picker-compact')}>
      <label className="app-expressive-picker-search app-blob-emoji-search">
        <Search className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
        <span className="sr-only">Search Blob Emoji</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search Blob Emoji"
          autoComplete="off"
          autoFocus
        />
      </label>
      <div className="app-blob-emoji-heading">
        <span>{query.trim() ? 'Results' : categories.find((item) => item.id === category)?.label}</span>
        <span>{visible.length}</span>
      </div>
      <div className="app-blob-emoji-grid" role="listbox" aria-label="Blob Emoji">
        {visible.map((emoji) => (
          <button
            key={emoji.id}
            type="button"
            role="option"
            className="app-blob-emoji-option"
            title={emoji.id}
            aria-label={emoji.id}
            onClick={() => select(emoji)}
          >
            <BlobEmojiImage emoji={emoji} decorative className="h-8 w-8" />
          </button>
        ))}
      </div>
      <div className="app-blob-emoji-categories" role="tablist" aria-label="Blob Emoji categories">
        {categories.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={category === item.id}
              className={cn('app-blob-emoji-category', category === item.id && 'app-blob-emoji-category-active')}
              onClick={() => {
                setQuery('');
                setCategory(item.id);
              }}
              title={item.label}
            >
              <Icon aria-hidden="true" />
              <span className="sr-only">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
