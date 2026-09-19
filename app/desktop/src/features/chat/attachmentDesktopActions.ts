import { invokeDesktop } from '@/lib/desktop';

export async function revealDesktopAttachment(path: string) {
  return invokeDesktop<string>('desktop_reveal_in_finder', { path });
}

export async function saveDesktopAttachmentAs(path: string, name?: string | null) {
  return invokeDesktop<string | null>('desktop_save_attachment_as', { path, name: name ?? null });
}
