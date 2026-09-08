import { EmojiPickerItemImage } from '@/features/emoji/EmojiPicker';
import type { EmojiPickerItem } from '@/features/emoji/emojiCatalog';

import { MessageDeliveryStatusSlot } from './transcriptMessageTransferActions';

export function StandaloneEmojiMessage({
  item,
  own,
  status,
}: {
  item: EmojiPickerItem;
  own: boolean;
  status?: string | null;
}) {
  return (
    <div
      className={`app-standalone-emoji-message inline-flex items-end gap-1${own ? ' pr-4' : ''}`}
      data-kordi-copy-surface="message"
    >
      <EmojiPickerItemImage item={item} className="h-11 w-11" />
      {own ? (
        <span className="app-message-delivery-footer inline-flex shrink-0 text-black/45">
          <MessageDeliveryStatusSlot status={status} />
        </span>
      ) : null}
    </div>
  );
}
