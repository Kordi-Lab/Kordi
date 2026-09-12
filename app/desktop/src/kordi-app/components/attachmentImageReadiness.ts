const ready = new Map<string, { widthPixels: number; heightPixels: number }>();
function cacheableKey(key: string | null | undefined): key is string { return Boolean(key && key.length <= 2048 && !key.startsWith('data:')); }
export function attachmentImageWasReady(url: string | null | undefined) { return cacheableKey(url) && ready.has(url); }
export function attachmentImageReadyDimensions(key: string | null | undefined) { return cacheableKey(key) ? ready.get(key) ?? null : null; }
export function markAttachmentImageReady(url: string, widthPixels: number, heightPixels: number) {
  // Readiness retains only compact identities, never inline image payloads.
  if (!cacheableKey(url) || !(widthPixels > 0 && heightPixels > 0)) return;
  ready.delete(url); ready.set(url, { widthPixels, heightPixels });
  while (ready.size > 512) ready.delete(ready.keys().next().value!);
}

export function stillAttachmentFrame(image: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 360 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch { return null; }
  finally { canvas.width = 0; canvas.height = 0; }
}
