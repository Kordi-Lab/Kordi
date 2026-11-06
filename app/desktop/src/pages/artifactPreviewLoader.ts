import { fetchDesktopChatArtifactPreview } from '@/lib/desktop';

export async function loadArtifactPreview(input: {
  isNativeShell: boolean; path: string; attachmentId?: string | null; baseRoot?: string | null;
}) {
  if (input.isNativeShell) return fetchDesktopChatArtifactPreview(input.path, input.baseRoot);
  if (import.meta.env?.VITE_KORDI_WEB_APP === '1') {
    const { fetchBrowserArtifactPreview } = await import('@web/runtime/browserArtifactPreview');
    return fetchBrowserArtifactPreview(input.path, input.attachmentId);
  }
  throw new Error('Artifact previews are available in the desktop app.');
}
