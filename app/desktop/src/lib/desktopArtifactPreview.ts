import { invokeDesktop } from './desktop';

/**
 * Registers an HTML or SVG artifact preview document with the native side and
 * returns the token that loads it from the preview URI scheme.
 */
export async function openDesktopArtifactPreviewDocument(source: string) {
  return invokeDesktop<string>('desktop_artifact_preview_document_open', { source });
}

/** Releases a preview document the inspector no longer shows. */
export async function closeDesktopArtifactPreviewDocument(token: string) {
  return invokeDesktop<void>('desktop_artifact_preview_document_close', { token });
}
