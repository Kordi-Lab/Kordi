import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { readDesktopChatAttachment } from '@/lib/desktop';
import type { MessageAttachment } from '@/kordi-app/types';

async function loadOriginalImage(attachment: MessageAttachment): Promise<Blob> {
  if (attachment.localPath) {
    const bytes = await readDesktopChatAttachment(attachment.localPath);
    return new Blob([new Uint8Array(bytes)], { type: attachment.mimeType ?? '' });
  }
  if (attachment.attachmentId) {
    const session = await loadSession();
    if (!session?.token) throw new Error('Sign in to copy this image.');
    return defaultCloudAuthClient().downloadAttachmentContent(session.token, attachment.attachmentId);
  }
  // A preview can be a reduced thumbnail. Only use an explicit original URL.
  if (!attachment.downloadUrl) throw new Error('The original image is not available.');
  const response = await fetch(attachment.downloadUrl);
  if (!response.ok) throw new Error('Unable to load the original image.');
  return response.blob();
}

export async function imageBlobToClipboardPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('Unable to copy this image.');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error('Unable to copy this image.')), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function copyAttachmentImage(attachment: MessageAttachment): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    return Promise.reject(new Error('Image copying is unavailable. Download the image instead.'));
  }
  // WebKit requires write() during the click, before any asynchronous image loading.
  const png = loadOriginalImage(attachment).then(imageBlobToClipboardPng);
  // A denied write may reject before the clipboard consumes the image promise.
  void png.catch(() => undefined);
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
