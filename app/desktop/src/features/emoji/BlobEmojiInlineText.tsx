import { Fragment } from 'react';

import { BlobEmojiImage } from './BlobEmojiImage';
import { blobEmojiTextParts } from './blobEmoji';

export function BlobEmojiInlineText({ text }: { text: string }) {
  return blobEmojiTextParts(text).map((part, index) => (
    part.type === 'emoji' ? (
      <BlobEmojiImage
        key={`${part.emoji.id}-${index}`}
        emoji={part.emoji}
        className="app-inline-blob-emoji"
      />
    ) : (
      <Fragment key={`text-${index}`}>{part.value}</Fragment>
    )
  ));
}
