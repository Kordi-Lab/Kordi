/** Sanitize a scratch name into a safe filename (no path separators / reserved chars). */
export function sanitizeFilename(name: string, fallback = 'scratch'): string {
  const trimmed = name.trim();
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return cleaned || fallback;
}

function isNativeDesktopShell(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function filenameExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

async function saveBlobInTauri(blob: Blob, filename: string): Promise<void> {
  const [{ save }, { invoke }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/core'),
  ]);

  const ext = filenameExtension(filename);
  const chosen = await save({
    defaultPath: filename,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  });
  if (!chosen) return; // user cancelled the Save dialog

  const buffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  await invoke('desktop_scratch_download_blob', { path: chosen, bytes });
}

/**
 * Save a generated download blob.
 *
 * - In a browser (web preview): use the standard `<a download>` anchor trick.
 * - In a Tauri webview: open a native Save dialog so the user can pick the
 *   destination, then write the bytes via `desktop_scratch_download_blob`.
 *   The webview ignores `<a download>`, so the anchor trick produces no file.
 */
export function saveBlob(blob: Blob, filename: string): void {
  if (isNativeDesktopShell()) {
    void saveBlobInTauri(blob, filename).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[scratch/download] Tauri save failed:', err);
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Defer revoke so the browser can finish initiating the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
