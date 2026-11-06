import type { DesktopStoredChatAttachment } from '@/lib/desktop';

type Attachment = { blob: Blob; name: string };
const attachments = new Map<string, Attachment>();
const cloudPaths = new Map<string, string>();
const streams = new Map<string, { name: string; chunks: Blob[] }>();
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

export function storeBrowserAttachment(blob: Blob, name: string): DesktopStoredChatAttachment {
  const path = URL.createObjectURL(blob);
  const safeName = name.replace(/[\\/\u0000-\u001f]/g, '_') || 'attachment.bin';
  attachments.set(path, { blob, name: safeName });
  return { path, name: safeName, kind: blob.type.startsWith('image/') ? 'image' : 'file',
    mimeType: blob.type || null, sizeBytes: blob.size };
}

export function browserAttachmentBlob(path: string): Blob {
  const value = attachments.get(path);
  if (!value) throw new Error('This file is no longer available in this browser tab. Attach or download it again.');
  return value.blob;
}

export function clearBrowserAttachments() {
  for (const path of attachments.keys()) URL.revokeObjectURL(path);
  attachments.clear(); cloudPaths.clear(); streams.clear();
}

export async function runBrowserAttachmentCommand(command: string, args: Record<string, unknown>, assertCurrent: () => Promise<void> = () => Promise.resolve()) {
  switch (command) {
    case 'desktop_chat_store_attachment_blob':
      return storeBrowserAttachment(args.blob as Blob, String(args.name));
    case 'desktop_chat_store_attachment':
      return storeBrowserAttachment(new Blob([new Uint8Array(args.data as number[])]), String(args.name)).path;
    case 'desktop_chat_read_attachment': {
      const blob = browserAttachmentBlob(String(args.path));
      if (blob.size > MAX_BUFFERED_BYTES) throw new Error('This file is too large to process in memory. Download it directly instead.');
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }
    case 'desktop_save_attachment_as':
    case 'desktop_chat_download_attachment': {
      const path = String(args.path);
      browserAttachmentBlob(path);
      const anchor = document.createElement('a');
      anchor.href = path;
      anchor.download = (typeof args.name === 'string' && args.name) || attachments.get(path)?.name || 'attachment.bin';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      return path;
    }
    case 'desktop_chat_discard_attachment': {
      const path = String(args.path);
      if (attachments.delete(path)) URL.revokeObjectURL(path);
      for (const [key, value] of cloudPaths) if (value === path) cloudPaths.delete(key);
      return;
    }
    case 'desktop_chat_cache_cloud_attachment': {
      const path = storeBrowserAttachment(new Blob([new Uint8Array(args.data as number[])]), String(args.name)).path;
      cloudPaths.set(String(args.attachmentId), path);
      return path;
    }
    case 'desktop_chat_cache_cloud_attachment_path': {
      const path = String(args.path);
      browserAttachmentBlob(path);
      cloudPaths.set(String(args.attachmentId), path);
      return path;
    }
    case 'desktop_chat_cached_cloud_attachment_path': return cloudPaths.get(String(args.attachmentId)) ?? null;
    case 'desktop_chat_download_cloud_attachment': {
      const { CloudAuthClient } = await import('@/features/cloud/authClient');
      const blob = await new CloudAuthClient().downloadAttachmentContent(String(args.token), String(args.attachmentId));
      await assertCurrent();
      const stored = storeBrowserAttachment(blob, String(args.name));
      cloudPaths.set(String(args.attachmentId), stored.path);
      return stored.path;
    }
    case 'desktop_chat_attachment_stream_start': {
      const id = crypto.randomUUID(); streams.set(id, { name: String(args.name), chunks: [] }); return id;
    }
    case 'desktop_chat_attachment_stream_append': {
      const stream = streams.get(String(args.streamId));
      if (!stream) throw new Error('The attachment transfer ended. Attach the file again.');
      stream.chunks.push(new Blob([new Uint8Array(args.data as number[])])); return;
    }
    case 'desktop_chat_attachment_stream_finish': {
      const id = String(args.streamId); const stream = streams.get(id);
      if (!stream) throw new Error('The attachment transfer ended. Attach the file again.');
      streams.delete(id); return storeBrowserAttachment(new Blob(stream.chunks), stream.name);
    }
    case 'desktop_chat_attachment_stream_cancel': streams.delete(String(args.streamId)); return;
    default: throw new Error('Local file access requires the Kordi desktop app.');
  }
}
