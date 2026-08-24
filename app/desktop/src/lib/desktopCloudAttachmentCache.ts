import { invokeDesktop } from './desktop';

export function cacheDesktopCloudAttachment(attachmentId: string, name: string, data: number[]) {
  return invokeDesktop<string>('desktop_chat_cache_cloud_attachment', { attachmentId, name, data });
}

export function cacheDesktopCloudAttachmentPath(attachmentId: string, name: string, path: string) {
  return invokeDesktop<string>('desktop_chat_cache_cloud_attachment_path', { attachmentId, name, path });
}

export function cachedDesktopCloudAttachmentPath(attachmentId: string, name: string) {
  return invokeDesktop<string | null>('desktop_chat_cached_cloud_attachment_path', { attachmentId, name });
}

export function downloadDesktopCloudAttachment(token: string, attachmentId: string, name: string) {
  return invokeDesktop<string>('desktop_chat_download_cloud_attachment', { token, attachmentId, name });
}
