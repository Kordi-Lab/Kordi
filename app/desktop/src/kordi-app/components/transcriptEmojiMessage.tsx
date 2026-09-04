import { EmojiPickerItemImage } from '@/features/emoji/EmojiPicker';
import type { EmojiPickerItem } from '@/features/emoji/emojiCatalog';
import { cn } from '@/lib/utils';

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
      className={cn('app-standalone-emoji-message relative h-11', own ? 'w-[4.5rem]' : 'w-11')}
      data-kordi-copy-surface="message"
    >
      <EmojiPickerItemImage item={item} className="h-11 w-11" />
      {own ? (
        <span className="app-message-delivery-footer absolute -bottom-0.5 -right-2 inline-flex text-black/45">
          <MessageDeliveryStatusSlot status={status} />
        </span>
      ) : null}
    </div>
  );
}
