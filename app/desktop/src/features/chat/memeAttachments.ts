import type { AttachmentItem } from './composerController.types';

export const MEME_ALT_TEXT_MAX_CHARACTERS = 500;

const MEME_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const MEME_IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);

function extensionFromName(name: string) {
  return name.trim().split('.').pop()?.toLowerCase() ?? '';
}

export function isSupportedMemeImage(attachment: Pick<AttachmentItem, 'kind' | 'mimeType' | 'name'>) {
  if (attachment.kind !== 'image') return false;
  const mimeType = attachment.mimeType?.trim().toLowerCase() ?? '';
  return mimeType ? MEME_IMAGE_MIME_TYPES.has(mimeType) : MEME_IMAGE_EXTENSIONS.has(extensionFromName(attachment.name));
}

export function memeAttachmentDraftError(
  attachments: readonly AttachmentItem[],
  options: { requireRightsConfirmation?: boolean } = {},
) {
  for (const attachment of attachments) {
    if (attachment.subtype !== 'meme') continue;
    if (!isSupportedMemeImage(attachment)) {
      return `Choose a PNG, JPEG, GIF, or WebP image for ${attachment.name}.`;
    }
    const altText = attachment.altText?.trim() ?? '';
    if (!altText) {
      return `Add alt text for ${attachment.name} before sending.`;
    }
    if (altText.length > MEME_ALT_TEXT_MAX_CHARACTERS) {
      return `Shorten the alt text for ${attachment.name} to ${MEME_ALT_TEXT_MAX_CHARACTERS} characters or fewer.`;
    }
    if (options.requireRightsConfirmation !== false && attachment.memeRightsConfirmed !== true) {
      return `Confirm that you have permission or another legal right to share ${attachment.name}.`;
    }
  }
  return null;
}
