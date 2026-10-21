import { openAttachmentMediaWindow } from '@/features/chat/attachmentMediaWindow';
import { downloadCloudAttachmentToLocalPath } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { loadSession } from '@/features/cloud/session';
import { openAttachmentInCompanion } from '@/features/documents/companionDocument';
import { safeExternalHttpHref } from '@/kordi-app/components/messageLinks';
import type { MessageAttachment } from '@/kordi-app/types';
import { isNativeDesktopShell, openDesktopExternalUrl } from '@/lib/desktop';
import type { SharedPhotoItem } from '@/pages/contactProfileSharedItems';

/** Opens the media window on the tapped photo, with every shared photo to page through. */
export function openSharedPhoto(photos: readonly SharedPhotoItem[], index: number, previewUrl?: string | null) {
  return openAttachmentMediaWindow({
    attachments: photos.map((photo) => photo.attachment),
    selectedIndex: index,
    initialPreviewUrl: previewUrl ?? null,
  });
}

/** Opens a file as its transcript bubble does: documents in the reader, others in their app. */
export async function openSharedFile(attachment: MessageAttachment) {
  if (openAttachmentInCompanion(attachment)) return;
  if (!isNativeDesktopShell()) return;
  let localPath = attachment.localPath?.trim() || null;
  if (!localPath && attachment.attachmentId) {
    const session = await loadSession();
    if (!session?.token) return;
    localPath = await downloadCloudAttachmentToLocalPath(
      session.token,
      attachment.attachmentId,
      attachment.name || 'attachment.bin',
    );
  }
  if (localPath) await openDesktopExternalUrl(localPath);
}

export async function openSharedLink(href: string) {
  const safe = safeExternalHttpHref(href);
  if (safe) await openDesktopExternalUrl(safe);
}
