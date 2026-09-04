import { useMemo, useState } from 'react';
import { Clock3, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { BlobEmojiImage } from './BlobEmojiImage';
import {
  blobEmojiItems,
  type EmojiPickerItem,
  notoEmojiItems,
  readRecentEmojiItems,
  recordRecentEmojiItem,
  representativeBlobEmoji,
  representativeNotoEmoji,
} from './emojiCatalog';
import { NotoEmojiImage } from './NotoEmojiImage';

export type EmojiPickerCategory = 'recent' | 'noto' | 'blob';

export function EmojiPickerItemImage({
  item,
  animated = true,
  className,
  decorative = false,
}: {
  item: EmojiPickerItem;
  animated?: boolean;
  className?: string;
  decorative?: boolean;
}) {
  return item.source === 'noto' ? (
    <NotoEmojiImage
      emoji={item.emoji}
      animated={animated}
      className={className}
      decorative={decorative}
    />
  ) : (
    <BlobEmojiImage emoji={item.emoji} className={className} decorative={decorative} />
  );
}

function EmojiOption({ item, onSelect }: { item: EmojiPickerItem; onSelect: () => void }) {
  const [previewing, setPreviewing] = useState(false);
  return (
    <button
      type="button"
      role="option"
      className="app-blob-emoji-option"
      title={item.name}
      aria-label={item.name}
      onPointerEnter={() => setPreviewing(true)}
      onPointerLeave={() => setPreviewing(false)}
      onFocus={() => setPreviewing(true)}
      onBlur={() => setPreviewing(false)}
      onClick={onSelect}
    >
      <EmojiPickerItemImage
        item={item}
        animated={item.source === 'blob' || previewing}
        decorative
        className="h-8 w-8"
      />
    </button>
  );
}

export function EmojiPicker({
  onSelect,
  compact = false,
  initialCategory = 'noto',
}: {
  onSelect: (item: EmojiPickerItem) => void;
  compact?: boolean;
  initialCategory?: EmojiPickerCategory;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<EmojiPickerCategory>(initialCategory);
  const [recentItems, setRecentItems] = useState(() => readRecentEmojiItems());
  const visible = useMemo(() => {
    const collection = category === 'recent'
      ? recentItems
      : category === 'noto' ? notoEmojiItems : blobEmojiItems;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizedQuery
      ? collection.filter((item) => item.searchText.includes(normalizedQuery))
      : collection;
  }, [category, query, recentItems]);
  const heading = category === 'recent' ? 'Recently used' : category === 'noto' ? 'Noto Emoji' : 'Blob Emoji';

  const select = (item: EmojiPickerItem) => {
    setRecentItems(recordRecentEmojiItem(item));
    onSelect(item);
  };

  return (
    <div className={cn('app-blob-emoji-picker', compact && 'app-blob-emoji-picker-compact')}>
      <label className="app-expressive-picker-search app-blob-emoji-search">
        <Search className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
        <span className="sr-only">Search {heading}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={`Search ${heading}`}
          autoComplete="off"
          autoFocus
        />
      </label>
      <div className="app-blob-emoji-heading">
        <span>{query.trim() ? 'Results' : heading}</span>
        <span>{visible.length}</span>
      </div>
      <div className="app-blob-emoji-grid" role="listbox" aria-label={heading}>
        {visible.map((item) => (
          <EmojiOption key={item.key} item={item} onSelect={() => select(item)} />
        ))}
      </div>
      <div className="app-blob-emoji-categories" role="tablist" aria-label="Emoji collections">
        <button
          type="button"
          role="tab"
          aria-label="Recent"
          aria-selected={category === 'recent'}
          className={cn('app-blob-emoji-category', category === 'recent' && 'app-blob-emoji-category-active')}
          onClick={() => {
            setQuery('');
            setCategory('recent');
          }}
          title="Recent"
        >
          <Clock3 aria-hidden="true" />
        </button>
        <button
          type="button"
          role="tab"
          aria-label="Noto Emoji"
          aria-selected={category === 'noto'}
          className={cn('app-blob-emoji-category', category === 'noto' && 'app-blob-emoji-category-active')}
          onClick={() => {
            setQuery('');
            setCategory('noto');
          }}
          title="Noto Emoji"
        >
          <NotoEmojiImage emoji={representativeNotoEmoji} animated={false} decorative className="app-emoji-collection-icon" />
        </button>
        <button
          type="button"
          role="tab"
          aria-label="Blob Emoji"
          aria-selected={category === 'blob'}
          className={cn('app-blob-emoji-category', category === 'blob' && 'app-blob-emoji-category-active')}
          onClick={() => {
            setQuery('');
            setCategory('blob');
          }}
          title="Blob Emoji"
        >
          <BlobEmojiImage emoji={representativeBlobEmoji} decorative className="app-emoji-collection-icon" />
        </button>
      </div>
    </div>
  );
}
