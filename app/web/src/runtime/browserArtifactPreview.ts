import type { DesktopArtifactPreview } from '@/kordi-app/types';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { captureChatDeliveryScope } from '@/features/cloud/chatDeliveryScope';

const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_PREVIEW_LINES = 400;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Matches the native text preview limits while reading only an authorized
 * attachment. A path from an agent's filesystem is never a browser fetch URL. */
export async function browserArtifactBlobPreview(path: string, blob: Blob): Promise<DesktopArtifactPreview> {
  const image = /\.(png|jpe?g|gif|webp|avif)$/i.test(path);
  if (image) {
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('This image is too large to preview. Download it to view the full file.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    const mime = blob.type.startsWith('image/') ? blob.type : `image/${path.split('.').pop()?.replace('jpg', 'jpeg')}`;
    return { path, lines: [{ number: 1, text: `data:${mime};base64,${btoa(binary)}` }], truncated: false };
  }
  const text = await blob.slice(0, MAX_PREVIEW_BYTES).text();
  if (text.includes('\0')) throw new Error("This artifact looks like a binary file and can't be previewed here.");
  const lines = text ? text.split('\n') : [];
  return { path, lines: lines.slice(0, MAX_PREVIEW_LINES).map((line, index) => ({ number: index + 1, text: line.replace(/\r$/, '') })),
    truncated: blob.size > MAX_PREVIEW_BYTES || lines.length > MAX_PREVIEW_LINES };
}

export async function fetchBrowserArtifactPreview(path: string, attachmentId: string | null | undefined): Promise<DesktopArtifactPreview> {
  if (!attachmentId) throw new Error('This artifact is stored on the agent’s computer. Upload it to the conversation to preview it in the browser.');
  const session = await loadSession();
  if (!session) throw new Error('Sign in to preview this artifact.');
  const scope = captureChatDeliveryScope(session.token, session.accountId);
  const blob = await defaultCloudAuthClient().downloadAttachmentContent(session.token, attachmentId);
  scope.assertCurrent();
  const preview = await browserArtifactBlobPreview(path, blob);
  scope.assertCurrent();
  return preview;
}
