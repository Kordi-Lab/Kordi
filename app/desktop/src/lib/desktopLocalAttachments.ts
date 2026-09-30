import { invokeDesktop } from './desktop';

/**
 * Opens a local attachment with the default app. The native side accepts only
 * files Kordi stored, received, saved, or that were attached, and refuses
 * types that can run code.
 */
export async function openDesktopLocalAttachment(path: string) {
  return invokeDesktop<string>('desktop_open_local_attachment', { path });
}

/** Must match `ATTACHMENT_ACCESS_DENIED` in `chat/attachments/access.rs`. */
export const DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE =
  'Kordi no longer has access to this file. Attach it again from its original location.';

export function isDesktopAttachmentAccessDenied(error: unknown) {
  return error instanceof Error && error.message.startsWith(DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE);
}

/**
 * Runs a native attachment action on `localPath`. When that path is no longer
 * available to Kordi (for example a file attached before access tracking
 * existed) and a Cloud copy can be resolved, the action is retried once on the
 * cached Cloud copy.
 */
export async function withDesktopAttachmentPathFallback<T>(
  localPath: string,
  resolveCloudCopy: (() => Promise<string | null>) | null,
  action: (path: string) => Promise<T>,
): Promise<T> {
  try {
    return await action(localPath);
  } catch (error) {
    if (!resolveCloudCopy || !isDesktopAttachmentAccessDenied(error)) throw error;
    const cloudCopy = await resolveCloudCopy();
    if (!cloudCopy || cloudCopy === localPath) throw error;
    return action(cloudCopy);
  }
}
