import {
  invokeDesktop,
  type DesktopStoredChatAttachment,
} from './desktop';

export function startDesktopChatAttachmentStream(name: string) {
  return invokeDesktop<string>('desktop_chat_attachment_stream_start', { name });
}

export async function appendDesktopChatAttachmentStream(streamId: string, chunk: Blob) {
  const data = Array.from(new Uint8Array(await chunk.arrayBuffer()));
  return invokeDesktop<void>('desktop_chat_attachment_stream_append', { streamId, data });
}

export function finishDesktopChatAttachmentStream(streamId: string) {
  return invokeDesktop<DesktopStoredChatAttachment>('desktop_chat_attachment_stream_finish', { streamId });
}

export function cancelDesktopChatAttachmentStream(streamId: string) {
  return invokeDesktop<void>('desktop_chat_attachment_stream_cancel', { streamId });
}

export function discardDesktopChatAttachment(path: string) {
  return invokeDesktop<void>('desktop_chat_discard_attachment', { path });
}

export async function storeDesktopChatAttachmentFile(
  file: File,
  name = file.name || 'attachment.bin',
  chunkSize = 1024 * 1024,
) {
  const streamId = await startDesktopChatAttachmentStream(name);
  try {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      await appendDesktopChatAttachmentStream(streamId, file.slice(offset, offset + chunkSize));
    }
    return await finishDesktopChatAttachmentStream(streamId);
  } catch (error) {
    await cancelDesktopChatAttachmentStream(streamId).catch(() => undefined);
    throw error;
  }
}
