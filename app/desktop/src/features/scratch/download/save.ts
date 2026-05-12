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

/** Trigger a browser download of the given blob with the given filename. */
export function saveBlob(blob: Blob, filename: string): void {
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
